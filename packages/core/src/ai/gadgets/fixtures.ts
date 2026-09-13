/**
 * Deterministic gadget fixtures (TASK-289).
 *
 * One place that produces a well-formed example of every kind, plus the
 * failure shapes the pipeline has to survive. Shared by the e2e suite and
 * available to anyone exercising the surface by hand, so a renderer change is
 * checked against the same payloads every time rather than against whatever a
 * model happened to emit that run.
 *
 * Nothing here is random or clock-dependent: `issuedAt` is supplied, IDs are
 * literal, and every collection is a fixed length.
 */
import type { GadgetScope } from './contracts';
import type { RawChatBlockInput } from './gadgetService';

export interface GadgetFixtureOptions {
  scope: GadgetScope;
  issuedAt: string;
}

function envelope(kind: string, gadgetId: string, payload: unknown, actions: unknown[], extra: Record<string, unknown> = {}) {
  return { version: 1, kind, gadgetId, payload, actions, ...extra };
}

/** One valid gadget of every kind, in catalogue order. */
export function buildGadgetFixtures({ scope, issuedAt }: GadgetFixtureOptions): RawChatBlockInput[] {
  const stamp = { scope, issuedAt };

  return [
    {
      type: 'gadget',
      blockId: 'fixture-choice',
      gadget: envelope(
        'choice',
        'fx-choice',
        {
          question: 'Which provider should continue this work?',
          detail: 'Praxis owns this decision, not the model.',
          options: [
            { value: 'claude', label: 'Claude', description: 'Strong at multi-file refactors.' },
            { value: 'codex', label: 'Codex', description: 'Fast on single-file edits.' },
            { value: 'copilot', label: 'Copilot', disabledReason: 'no CLI found on this machine' }
          ]
        },
        [{ actionId: 'pick', label: 'Continue', effect: 'informational' }],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-confirmation',
      gadget: envelope(
        'confirmation',
        'fx-confirmation',
        {
          question: 'Apply the proposed change to notes.md?',
          detail: 'The file has not been modified since the agent read it.',
          consequences: ['Write 3 lines to notes.md', 'Leave the working tree otherwise untouched']
        },
        [
          { actionId: 'apply', label: 'Apply change', effect: 'mutating', gate: 'changes.apply' },
          { actionId: 'decline', label: 'Leave it', effect: 'informational' }
        ],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-form',
      gadget: envelope(
        'form',
        'fx-form',
        {
          title: 'Describe the release',
          description: 'Used for the changelog entry.',
          fields: [
            { name: 'summary', label: 'Summary', type: 'text', required: true, maxLength: 80 },
            { name: 'notes', label: 'Notes', type: 'textarea', placeholder: 'Anything reviewers should know' },
            { name: 'channel', label: 'Channel', type: 'select', options: [{ value: 'beta', label: 'Beta' }, { value: 'stable', label: 'Stable' }] },
            { name: 'breaking', label: 'Contains breaking changes', type: 'boolean' }
          ]
        },
        [{ actionId: 'save', label: 'Save', effect: 'informational' }],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-table',
      gadget: envelope(
        'table',
        'fx-table',
        {
          title: 'Check results',
          columns: [
            { key: 'check', label: 'Check' },
            { key: 'duration', label: 'Duration', align: 'end', mono: true },
            { key: 'passed', label: 'Passed', align: 'end' }
          ],
          rows: [
            { check: 'lint', duration: '2.1s', passed: true },
            { check: 'unit', duration: '18.4s', passed: true },
            { check: 'e2e', duration: '3m 02s', passed: false }
          ],
          caption: 'From the most recent run.'
        },
        [],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-chart',
      gadget: envelope(
        'chart',
        'fx-chart',
        {
          title: 'Build duration',
          chartKind: 'line',
          xLabel: 'Run',
          series: [
            { label: 'build', points: [{ x: 1, y: 120 }, { x: 2, y: 96 }, { x: 3, y: 104 }, { x: 4, y: 88 }] },
            { label: 'test', points: [{ x: 1, y: 240 }, { x: 2, y: 232 }, { x: 3, y: 251 }, { x: 4, y: 228 }] }
          ],
          summary: 'Build time is trending down; test time is flat.'
        },
        [],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-progress',
      gadget: envelope(
        'progress',
        'fx-progress',
        {
          title: 'Delivery run',
          status: 'running',
          percent: 60,
          detail: 'Running the e2e suite.',
          steps: [
            { label: 'Build', state: 'done' },
            { label: 'Unit tests', state: 'done' },
            { label: 'E2E tests', state: 'running' },
            { label: 'Publish', state: 'pending' }
          ]
        },
        [],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-diff',
      gadget: envelope(
        'diff',
        'fx-diff',
        {
          title: 'Proposed changes',
          summary: 'Two files touched.',
          openInChangesRef: 'session',
          files: [
            { path: 'src/notes.md', status: 'modified', additions: 3, deletions: 1, preview: '+ a new line\n- an old line' },
            { path: 'src/added.ts', status: 'added', additions: 12, deletions: 0 }
          ]
        },
        [
          { actionId: 'approve-diff', label: 'Approve changes', effect: 'approval', gate: 'changes.approve' },
          { actionId: 'reject-diff', label: 'Reject', effect: 'informational' }
        ],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-artifact',
      gadget: envelope(
        'artifact',
        'fx-artifact',
        {
          title: 'Run artifacts',
          artifacts: [
            { name: 'Coverage report', path: 'output/coverage/index.html', mediaType: 'text/html', sizeBytes: 48_120 },
            { name: 'Playwright trace', path: 'output/playwright/trace.zip', sizeBytes: 2_310_400, description: 'Full trace for the failing spec.' }
          ]
        },
        [],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-handoff',
      gadget: envelope(
        'handoff',
        'fx-handoff',
        {
          title: 'Hand this work to another provider',
          fromProvider: 'Claude',
          toProvider: 'Codex',
          contextSummary: 'Refactor the settings mirror so renderer defaults stop drifting.\nTwo files changed so far.',
          includedItems: [
            { label: 'Task goal and definition of done' },
            { label: 'Files changed in this session', detail: '2 files' }
          ],
          excludedItems: [{ label: 'Full tool transcript', reason: 'too large for the target context window' }],
          warning: 'The receiving provider will not see the earlier conversation.'
        },
        [
          { actionId: 'approve-handoff', label: 'Approve handoff', effect: 'approval', gate: 'session.handoff' },
          { actionId: 'cancel-handoff', label: 'Stay here', effect: 'informational' }
        ],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-conflict',
      gadget: envelope(
        'conflict',
        'fx-conflict',
        {
          title: 'Resolve two conflicting edits',
          description: 'The agent and your working tree changed the same lines.',
          conflicts: [
            { id: 'readme', label: 'README.md heading', path: 'README.md', ours: '# Praxis', theirs: '# Praxis Desktop' },
            { id: 'version', label: 'package version', path: 'package.json', ours: '0.3.1', theirs: '0.4.0' }
          ]
        },
        [{ actionId: 'resolve', label: 'Apply resolutions', effect: 'mutating', gate: 'changes.resolve' }],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-approval',
      gadget: envelope(
        'approval',
        'fx-approval',
        {
          title: 'Approve deployment to staging',
          summary: 'All checks passed on commit 4b9d07e.',
          gate: 'deployment.staging',
          requestedBy: 'delivery workflow',
          effect: 'publish the build to the staging environment',
          evidence: [
            { label: 'Commit', value: '4b9d07e' },
            { label: 'Checks', value: '3 passed, 0 failed' },
            { label: 'Artifact', value: 'praxis-desktop-0.3.1.dmg' }
          ]
        },
        [
          { actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'deployment.staging' },
          { actionId: 'reject', label: 'Reject', effect: 'informational' }
        ],
        stamp
      )
    }
  ];
}

/**
 * The shapes the pipeline must survive without crashing or going silent.
 *
 * Each of these is expected to come back as a `fallback` block rather than a
 * gadget — proving the "no silent failure" property for malformed, oversized,
 * unknown, ungated and out-of-contract payloads.
 */
export function buildGadgetFailureFixtures({ scope, issuedAt }: GadgetFixtureOptions): RawChatBlockInput[] {
  const stamp = { scope, issuedAt };
  return [
    {
      type: 'gadget',
      blockId: 'fixture-unknown-kind',
      gadget: envelope('teleporter', 'fx-unknown', { anything: true }, [], {
        ...stamp,
        fallbackText: 'The agent asked for a surface this build does not have.'
      })
    },
    {
      type: 'gadget',
      blockId: 'fixture-future-version',
      gadget: { ...envelope('choice', 'fx-future', { question: 'Later?', options: [{ value: 'a', label: 'A' }] }, [], stamp), version: 99 }
    },
    {
      type: 'gadget',
      blockId: 'fixture-oversized',
      gadget: envelope(
        'table',
        'fx-oversized',
        { columns: [{ key: 'a', label: 'A' }], rows: [{ a: 'x'.repeat(200_000) }] },
        [],
        stamp
      )
    },
    {
      type: 'gadget',
      blockId: 'fixture-schema-invalid',
      gadget: envelope('choice', 'fx-invalid', { question: 'Missing option values', options: [{ label: 'no value' }] }, [], stamp)
    },
    {
      type: 'gadget',
      blockId: 'fixture-ungated-mutation',
      gadget: envelope('confirmation', 'fx-ungated', { question: 'Delete the branch?' }, [
        { actionId: 'delete', label: 'Delete', effect: 'mutating' }
      ], stamp)
    },
    {
      type: 'gadget',
      blockId: 'fixture-traversal',
      gadget: envelope('artifact', 'fx-traversal', { title: 'Files', artifacts: [{ name: 'passwd', path: '../../../etc/passwd' }] }, [], stamp)
    }
  ];
}

/** A gadget that is already expired, for proving the stale path. */
export function buildExpiredGadgetFixture({ scope, issuedAt }: GadgetFixtureOptions): RawChatBlockInput {
  return {
    type: 'gadget',
    blockId: 'fixture-expired',
    gadget: envelope(
      'choice',
      'fx-expired',
      { question: 'This one timed out', options: [{ value: 'a', label: 'Too late' }] },
      [{ actionId: 'pick', label: 'Continue', effect: 'informational' }],
      { scope, issuedAt, expiresAt: new Date(Date.parse(issuedAt) + 1000).toISOString() }
    )
  };
}

/**
 * The catalogue rendered the way a provider actually asks for it.
 *
 * Scope and issue time are stripped, because a producer does not get to set
 * them — the host stamps them during parsing. What is left is exactly what a
 * model would emit, which is what makes an end-to-end test of this string a
 * test of the real path rather than of a hand-built envelope.
 */
export function buildGadgetFenceMessage(
  blocks: readonly RawChatBlockInput[],
  intro = 'Here is what I found.'
): string {
  const fences = blocks
    .filter((block): block is Extract<RawChatBlockInput, { type: 'gadget' }> => block.type === 'gadget')
    .map(block => {
      const { scope: _scope, issuedAt: _issuedAt, ...request } = block.gadget as Record<string, unknown>;
      return ['```praxis-gadget', JSON.stringify(request, null, 2), '```'].join('\n');
    });
  return [intro, ...fences].join('\n\n');
}
