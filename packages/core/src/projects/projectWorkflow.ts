import type { ProjectWorkflowCategory, ProjectWorkflowStage } from './projectTypes';

/**
 * A project's workflow, as data (FX-BF-019).
 *
 * A workflow describes how a team works. It is authored once, stays editable,
 * and every backend renders it in its own storage — Jira as its board's
 * statuses, GitHub as `status: …` labels, folder as the status text in its
 * markdown, app-storage as the project record's own stages.
 *
 * The piece that makes that possible for freeform sources is the stage
 * **category**. Plan documents are prose written by people and agents
 * ("✅ Complete", "🚧 In progress", "📋 Proposed"); you cannot infer
 * "Architecture" from "Proposed". Resolving through a category means a
 * freeform status still lands somewhere sensible on *any* declared workflow.
 */

export const WORKFLOW_CATEGORIES: readonly ProjectWorkflowCategory[] = [
  'todo',
  'indeterminate',
  'done'
];

/**
 * The five statuses every board used before a workflow could be declared.
 *
 * This is the fallback for any caller with no workflow of its own, which is
 * what keeps existing folder boards byte-identical: same names, same order,
 * same categories as the constant this replaced in `folderService`.
 */
export const DEFAULT_WORKFLOW: readonly ProjectWorkflowStage[] = Object.freeze([
  Object.freeze({ id: 'stage-backlog', name: 'Backlog', category: 'todo' as const }),
  Object.freeze({ id: 'stage-to-do', name: 'To Do', category: 'todo' as const }),
  Object.freeze({ id: 'stage-in-progress', name: 'In Progress', category: 'indeterminate' as const }),
  Object.freeze({ id: 'stage-blocked', name: 'Blocked', category: 'indeterminate' as const }),
  Object.freeze({ id: 'stage-done', name: 'Done', category: 'done' as const })
]);

/**
 * Synonyms for a freeform status, in match order.
 *
 * Each entry carries a **preferred stage name** as well as a category. The
 * preferred name is what preserves fidelity on the default workflow: "blocked"
 * has to reach `Blocked`, not merely the first `indeterminate` stage, and
 * "to do" has to reach `To Do`, not merely the first `todo` stage. When a
 * workflow has no stage by that name the category takes over.
 *
 * Order matters and mirrors the mapper this replaced: `complete` is tested
 * before `progress` so "✅ Complete" never reads as in-progress.
 */
const SYNONYMS: ReadonlyArray<{
  match: readonly string[];
  prefer: string;
  category: ProjectWorkflowCategory;
}> = [
  { match: ['complete', 'done', '✅', 'shipped', 'closed', 'resolved'], prefer: 'Done', category: 'done' },
  { match: ['block'], prefer: 'Blocked', category: 'indeterminate' },
  { match: ['progress', 'doing', 'wip', '🔄', 'active'], prefer: 'In Progress', category: 'indeterminate' },
  { match: ['review'], prefer: 'Review', category: 'indeterminate' },
  { match: ['to do', 'todo', 'pending', 'planned', 'next'], prefer: 'To Do', category: 'todo' },
  { match: ['backlog', 'proposed', '📋', 'new', 'open', 'idea'], prefer: 'Backlog', category: 'todo' }
];

/** Lowercased, punctuation- and emoji-tolerant form used for name comparison. */
function comparable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether a raw status matches one of a synonym entry's tokens.
 *
 * A token that is entirely punctuation or emoji ("✅") has an empty
 * `comparable` form, and `"anything".includes("")` is true — so those tokens
 * must be tested against the raw string only. Matching them the other way
 * makes every status match the first entry.
 */
function matchesSynonym(
  entry: { match: readonly string[] },
  raw: string,
  needle: string
): boolean {
  return entry.match.some(token => {
    const normalized = comparable(token);
    return normalized ? needle.includes(normalized) : raw.includes(token);
  });
}

function stagesOf(workflow: readonly ProjectWorkflowStage[] | undefined): readonly ProjectWorkflowStage[] {
  return workflow && workflow.length > 0 ? workflow : DEFAULT_WORKFLOW;
}

/** The category a stage declares, defaulting by position when it declares none. */
export function categoryOfStage(
  stage: ProjectWorkflowStage,
  index: number,
  total: number
): ProjectWorkflowCategory {
  if (stage.category) return stage.category;
  return inferCategory(stage.name, index, total);
}

/**
 * Best category for a stage that does not declare one: its name if the name is
 * recognisable, otherwise its position — first is `todo`, last is `done`, and
 * everything between is in flight.
 */
export function inferCategory(
  name: string,
  index: number,
  total: number
): ProjectWorkflowCategory {
  const needle = comparable(name);
  for (const entry of SYNONYMS) {
    if (matchesSynonym(entry, name, needle)) {
      return entry.category;
    }
  }
  if (index === 0) return 'todo';
  if (index === total - 1) return 'done';
  return 'indeterminate';
}

/**
 * Fills in any missing category so downstream code can rely on one. Records
 * written before FX-BE-043 repair on read rather than needing a migration
 * script.
 */
export function normalizeWorkflowStages(
  stages: readonly ProjectWorkflowStage[] | undefined
): ProjectWorkflowStage[] {
  const source = stagesOf(stages);
  return source.map((stage, index) => ({
    ...stage,
    category: categoryOfStage(stage, index, source.length)
  }));
}

/** Stage names in board order. */
export function workflowStatusNames(
  workflow: readonly ProjectWorkflowStage[] | undefined
): string[] {
  return stagesOf(workflow).map(stage => stage.name);
}

/** The first stage of a category, or undefined when the workflow has none. */
export function firstStageOfCategory(
  workflow: readonly ProjectWorkflowStage[] | undefined,
  category: ProjectWorkflowCategory
): ProjectWorkflowStage | undefined {
  const stages = normalizeWorkflowStages(stagesOf(workflow));
  return stages.find(stage => stage.category === category);
}

/**
 * Resolves a freeform status string onto one of the workflow's stages, in four
 * tiers:
 *
 * 1. an exact stage name, case- and punctuation-insensitive — `"Architecture"`;
 * 2. a synonym's preferred stage name, when the workflow has one — `"blocked"`
 *    reaches `Blocked` rather than merely the first in-flight stage;
 * 3. the first stage of the synonym's category — so `"✅ Complete"` reaches
 *    whatever *this* workflow calls done;
 * 4. the first stage, so a status is never dropped and never `undefined`.
 *
 * Against {@link DEFAULT_WORKFLOW} this returns exactly what the five-status
 * mapper it replaced returned, for every input that mapper handled.
 */
export function resolveStatus(
  raw: string,
  workflow?: readonly ProjectWorkflowStage[]
): string {
  const stages = normalizeWorkflowStages(stagesOf(workflow));
  const fallback = stages[0].name;
  const needle = comparable(raw ?? '');
  if (!needle && !raw?.trim()) {
    return fallback;
  }

  // 1 — exact stage name.
  const exact = stages.find(stage => comparable(stage.name) === needle);
  if (exact) return exact.name;

  // 2/3 — synonym, preferring its canonical name then its category.
  for (const entry of SYNONYMS) {
    if (!matchesSynonym(entry, raw, needle)) continue;
    const preferred = stages.find(stage => comparable(stage.name) === comparable(entry.prefer));
    if (preferred) return preferred.name;
    const byCategory = stages.find(stage => stage.category === entry.category);
    if (byCategory) return byCategory.name;
  }

  // 4 — never drop a status.
  return fallback;
}

/** Rank used to order columns for a workflow, mirroring `jiraShape.statusCategoryRank`. */
export function workflowCategoryRank(category: string | undefined): number {
  if (category === 'todo') return 0;
  if (category === 'indeterminate') return 1;
  if (category === 'done') return 2;
  return 3;
}

/**
 * Validation shared by the store and the workflow editor, so the UI can show
 * the same named reason the save would throw.
 */
export function validateWorkflowStages(stages: readonly ProjectWorkflowStage[]): string | undefined {
  if (stages.length < 2 || stages.some(stage => !stage.name.trim())) {
    return 'At least two named workflow stages are required.';
  }
  const names = new Set(stages.map(stage => stage.name.trim().toLowerCase()));
  if (names.size !== stages.length) {
    return 'Workflow stage names must be unique.';
  }
  const normalized = normalizeWorkflowStages(stages);
  if (!normalized.some(stage => stage.category === 'todo')) {
    return 'A workflow needs at least one stage where work starts.';
  }
  const done = normalized.filter(stage => stage.category === 'done');
  if (done.length !== 1) {
    return 'A workflow needs exactly one stage that means done.';
  }
  if (normalized[normalized.length - 1].category !== 'done') {
    return 'The stage that means done must be last.';
  }
  return undefined;
}
