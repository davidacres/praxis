import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { ProjectWorkflowStage } from './projectTypes';
import {
  DEFAULT_WORKFLOW,
  firstStageOfCategory,
  inferCategory,
  normalizeWorkflowStages,
  resolveStatus,
  validateWorkflowStages,
  workflowCategoryRank,
  workflowStatusNames
} from './projectWorkflow';

/** The `software` template's workflow — the case that motivated FX-BF-019. */
const SOFTWARE: ProjectWorkflowStage[] = [
  { id: '1', name: 'Backlog', category: 'todo' },
  { id: '2', name: 'Requirements', category: 'todo' },
  { id: '3', name: 'Architecture', category: 'indeterminate' },
  { id: '4', name: 'Implementation', category: 'indeterminate' },
  { id: '5', name: 'Verification', category: 'indeterminate' },
  { id: '6', name: 'Done', category: 'done' }
];

// ── Equivalence with the mapper this replaced ───────────────────────
//
// Ported verbatim from `mapMarkdownStatusToPlanStatus`, which was:
//   complete|done|✅ -> Done · block -> Blocked · progress|doing|wip|🔄 ->
//   In Progress · to do|todo|pending|planned -> To Do · backlog -> Backlog ·
//   anything else -> Backlog

test('against the default workflow every legacy mapping is preserved', () => {
  const cases: Array<[string, string]> = [
    ['Complete', 'Done'],
    ['✅ Complete', 'Done'],
    ['complete', 'Done'],
    ['done', 'Done'],
    ['Blocked', 'Blocked'],
    ['blocked on review', 'Blocked'],
    ['In Progress', 'In Progress'],
    ['🔄 In progress', 'In Progress'],
    ['doing', 'In Progress'],
    ['wip', 'In Progress'],
    ['To Do', 'To Do'],
    ['todo', 'To Do'],
    ['pending', 'To Do'],
    ['planned', 'To Do'],
    ['Backlog', 'Backlog'],
    ['Proposed', 'Backlog'],
    ['something nobody recognises', 'Backlog'],
    ['', 'Backlog']
  ];
  for (const [input, expected] of cases) {
    assert.equal(resolveStatus(input, DEFAULT_WORKFLOW), expected, `${input} -> ${expected}`);
  }
});

test('no workflow at all behaves as the default workflow', () => {
  assert.equal(resolveStatus('✅ Complete'), 'Done');
  assert.equal(resolveStatus('anything'), 'Backlog');
  assert.deepEqual(workflowStatusNames(undefined), [
    'Backlog', 'To Do', 'In Progress', 'Blocked', 'Done'
  ]);
  assert.deepEqual(workflowStatusNames([]), workflowStatusNames(undefined));
});

// ── Resolution against a declared workflow ──────────────────────────

test('an exact stage name wins, case- and punctuation-insensitively', () => {
  assert.equal(resolveStatus('Architecture', SOFTWARE), 'Architecture');
  assert.equal(resolveStatus('architecture', SOFTWARE), 'Architecture');
  assert.equal(resolveStatus('  Verification  ', SOFTWARE), 'Verification');
  assert.equal(resolveStatus('Requirements', SOFTWARE), 'Requirements');
});

test('a freeform status falls back to the workflow`s own category stages', () => {
  // "Done" exists by name in this workflow.
  assert.equal(resolveStatus('✅ Complete', SOFTWARE), 'Done');
  // No "In Progress" stage — first `indeterminate` is Architecture.
  assert.equal(resolveStatus('🚧 In progress', SOFTWARE), 'Architecture');
  // No "Blocked" stage either — same category, same first stage.
  assert.equal(resolveStatus('blocked', SOFTWARE), 'Architecture');
  // No "To Do" stage — first `todo` is Backlog.
  assert.equal(resolveStatus('pending', SOFTWARE), 'Backlog');
});

test('an unrecognised status resolves to the first stage, never undefined', () => {
  assert.equal(resolveStatus('zzz', SOFTWARE), 'Backlog');
  assert.equal(resolveStatus('', SOFTWARE), 'Backlog');
  const odd: ProjectWorkflowStage[] = [
    { id: 'a', name: 'Icebox', category: 'todo' },
    { id: 'b', name: 'Shipped', category: 'done' }
  ];
  assert.equal(resolveStatus('nonsense', odd), 'Icebox');
  assert.equal(resolveStatus('✅ Complete', odd), 'Shipped');
});

// ── Category inference / migration ──────────────────────────────────

test('a recognisable name infers its category regardless of position', () => {
  assert.equal(inferCategory('Done', 1, 5), 'done');
  assert.equal(inferCategory('In Progress', 0, 5), 'indeterminate');
  assert.equal(inferCategory('Backlog', 3, 5), 'todo');
});

test('an unrecognisable name infers from position: first todo, last done, rest in flight', () => {
  assert.equal(inferCategory('Hypothesis', 0, 4), 'todo');
  assert.equal(inferCategory('Method', 1, 4), 'indeterminate');
  assert.equal(inferCategory('Synthesis', 2, 4), 'indeterminate');
  // The last stage is where work ends, whatever it is called — this is how the
  // experiment template's "Decision" and the research template's "Review" get
  // the right category without being named after one.
  assert.equal(inferCategory('Decision', 3, 4), 'done');
});

test('normalizeWorkflowStages repairs records written without categories', () => {
  const legacy = [
    { id: '1', name: 'Backlog' },
    { id: '2', name: 'Source planning' },
    { id: '3', name: 'Evidence' },
    { id: '4', name: 'Wrapped' }
  ];
  assert.deepEqual(
    normalizeWorkflowStages(legacy).map(s => s.category),
    ['todo', 'indeterminate', 'indeterminate', 'done']
  );
});

test('normalizeWorkflowStages leaves declared categories alone and defaults an empty workflow', () => {
  assert.deepEqual(normalizeWorkflowStages(SOFTWARE), SOFTWARE);
  assert.deepEqual(normalizeWorkflowStages(undefined), [...DEFAULT_WORKFLOW]);
});

test('firstStageOfCategory finds the workflow`s own stage for a category', () => {
  assert.equal(firstStageOfCategory(SOFTWARE, 'indeterminate')?.name, 'Architecture');
  assert.equal(firstStageOfCategory(SOFTWARE, 'done')?.name, 'Done');
  assert.equal(firstStageOfCategory(DEFAULT_WORKFLOW, 'todo')?.name, 'Backlog');
});

test('workflowCategoryRank orders todo before in-flight before done', () => {
  assert.ok(workflowCategoryRank('todo') < workflowCategoryRank('indeterminate'));
  assert.ok(workflowCategoryRank('indeterminate') < workflowCategoryRank('done'));
  assert.equal(workflowCategoryRank('nonsense'), 3);
});

// ── Validation ──────────────────────────────────────────────────────

test('validateWorkflowStages accepts the shipped workflows', () => {
  assert.equal(validateWorkflowStages(DEFAULT_WORKFLOW), undefined);
  assert.equal(validateWorkflowStages(SOFTWARE), undefined);
});

test('validateWorkflowStages names the reason it refuses', () => {
  assert.match(validateWorkflowStages([{ id: '1', name: 'Only' }])!, /at least two/i);
  assert.match(
    validateWorkflowStages([{ id: '1', name: 'A' }, { id: '2', name: 'a' }])!,
    /unique/i
  );
  assert.match(
    validateWorkflowStages([
      { id: '1', name: 'Doing', category: 'indeterminate' },
      { id: '2', name: 'Done', category: 'done' }
    ])!,
    /where work starts/i
  );
  assert.match(
    validateWorkflowStages([
      { id: '1', name: 'Backlog', category: 'todo' },
      { id: '2', name: 'Shipped', category: 'done' },
      { id: '3', name: 'Done', category: 'done' }
    ])!,
    /exactly one stage that means done/i
  );
  assert.match(
    validateWorkflowStages([
      { id: '1', name: 'Backlog', category: 'todo' },
      { id: '2', name: 'Done', category: 'done' },
      { id: '3', name: 'Review', category: 'indeterminate' }
    ])!,
    /must be last/i
  );
});
