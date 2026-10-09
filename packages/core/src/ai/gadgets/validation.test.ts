import assert from 'node:assert/strict';
import test from 'node:test';
import { GADGET_CONTRACT_VERSION } from './contracts';
import { GADGET_LIMITS } from './limits';
import { coerceGadgetBlock, isGadgetActionValue, validateGadgetActionValue, validateGadgetEnvelope } from './validation';
import { gadgetFallbackText, gadgetFallbackWithActions } from './fallback';
import { mayContainGadget, parseChatBlocks } from './blockParser';
import { redactSecrets } from './redaction';
import type { AnyGadgetEnvelope, GadgetAction, GadgetKind, TableGadgetPayload } from './contracts';

const SCOPE = { hostId: 'host-1', projectId: 'project-1', sessionId: 'session-1', workId: 'FX-1', revision: 3 };

function envelope(kind: GadgetKind, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: `gadget-${kind}`,
    kind,
    scope: SCOPE,
    issuedAt: '2026-09-13T10:00:00.000Z',
    fallbackText: '',
    payload,
    actions: [{ actionId: 'submit', label: 'Continue', effect: 'informational' }],
    ...overrides
  };
}

const CHOICE_PAYLOAD = {
  question: 'What should happen next?',
  options: [
    { value: 'local', label: 'Keep local' },
    { value: 'handoff', label: 'Handoff', description: 'Prepare for another provider.' }
  ]
};

function expectOk(input: unknown, options?: Parameters<typeof validateGadgetEnvelope>[1]): AnyGadgetEnvelope {
  const outcome = validateGadgetEnvelope(input, options);
  assert.equal(outcome.ok, true, outcome.ok ? '' : `${outcome.error.code}: ${outcome.error.message}`);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.envelope;
}

function expectError(input: unknown, options?: Parameters<typeof validateGadgetEnvelope>[1]) {
  const outcome = validateGadgetEnvelope(input, options);
  assert.equal(outcome.ok, false, 'expected validation to fail');
  if (outcome.ok) throw new Error('unreachable');
  return outcome.error;
}

test('accepts a well-formed choice gadget and derives its fallback text', () => {
  const result = expectOk(envelope('choice', CHOICE_PAYLOAD));
  assert.equal(result.kind, 'choice');
  assert.equal(result.state, 'active');
  // The producer left `fallbackText` empty, so the contract's promise that
  // every gadget is representable as text has to be kept by validation.
  assert.match(result.fallbackText, /What should happen next\?/);
  assert.match(result.fallbackText, /Keep local/);
  assert.match(result.fallbackText, /Prepare for another provider/);
});

test('keeps a producer-supplied fallback rather than overwriting it', () => {
  const result = expectOk(envelope('choice', CHOICE_PAYLOAD, { fallbackText: 'Reply local or handoff.' }));
  assert.equal(result.fallbackText, 'Reply local or handoff.');
});

test('refuses an unknown kind and a version from the future', () => {
  assert.equal(expectError(envelope('teleporter' as GadgetKind, {})).code, 'unsupported-kind');
  assert.equal(expectError(envelope('choice', CHOICE_PAYLOAD, { version: GADGET_CONTRACT_VERSION + 1 })).code, 'unsupported-version');
});

test('refuses a payload past the byte ceiling before parsing it', () => {
  const huge = { ...CHOICE_PAYLOAD, detail: 'x'.repeat(GADGET_LIMITS.envelopeBytes) };
  const error = expectError(envelope('choice', huge));
  assert.equal(error.code, 'payload-too-large');
  assert.match(error.message, /KB/);
});

test('reports the failing path for a schema error', () => {
  const error = expectError(envelope('choice', { question: 'Pick', options: [{ label: 'No value' }] }));
  assert.equal(error.code, 'schema-invalid');
  assert.equal(error.path, 'payload.options[0].value');
});

test('refuses a default that names no option, and duplicate option values', () => {
  assert.equal(expectError(envelope('choice', { ...CHOICE_PAYLOAD, defaultValue: 'nope' })).path, 'payload.defaultValue');
  const duplicated = { question: 'Pick', options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'Again' }] };
  assert.match(expectError(envelope('choice', duplicated)).message, /Duplicate option value/);
});

test('trims an oversized table and marks it truncated rather than refusing it', () => {
  const rows = Array.from({ length: GADGET_LIMITS.tableRows + 25 }, (_, index) => ({ name: `row-${index}`, count: index }));
  const result = expectOk(
    envelope('table', { columns: [{ key: 'name', label: 'Name' }, { key: 'count', label: 'Count' }], rows })
  );
  const payload = result.payload as { rows: unknown[]; truncated: boolean };
  assert.equal(payload.rows.length, GADGET_LIMITS.tableRows);
  assert.equal(payload.truncated, true);
});

test('a narrow client capability trims the table further', () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({ name: `row-${index}` }));
  const result = expectOk(envelope('table', { columns: [{ key: 'name', label: 'Name' }], rows }), {
    capability: { version: GADGET_CONTRACT_VERSION, kinds: ['table'], maxTableRows: 50 }
  });
  const payload = result.payload as { rows: unknown[]; truncated: boolean };
  assert.equal(payload.rows.length, 50);
  assert.equal(payload.truncated, true);
});

test('a capability that cannot draw the kind is refused, not silently rendered', () => {
  const error = expectError(envelope('chart', { chartKind: 'bar', series: [{ label: 'a', points: [{ x: 1, y: 2 }] }] }), {
    capability: { version: GADGET_CONTRACT_VERSION, kinds: ['choice'] }
  });
  assert.equal(error.code, 'capability-denied');
});

test('refuses extra choice options rather than dropping a decision silently', () => {
  const options = Array.from({ length: GADGET_LIMITS.choiceOptions + 1 }, (_, index) => ({ value: `v${index}`, label: `L${index}` }));
  const error = expectError(envelope('choice', { question: 'Pick', options }));
  assert.equal(error.code, 'payload-too-large');
  assert.equal(error.path, 'payload.options');
});

test('a mutating or approval action must declare a workflow gate', () => {
  const ungated = envelope('confirmation', { question: 'Apply the change?' }, {
    actions: [{ actionId: 'apply', label: 'Apply', effect: 'mutating' }]
  });
  const error = expectError(ungated);
  assert.equal(error.code, 'gate-required');

  const gated = envelope('confirmation', { question: 'Apply the change?' }, {
    actions: [{ actionId: 'apply', label: 'Apply', effect: 'mutating', gate: 'changes.apply' }]
  });
  assert.equal(expectOk(gated).actions[0].gate, 'changes.apply');
});

test('masks secret-shaped strings anywhere in the payload and flags the envelope', () => {
  const result = expectOk(
    envelope('table', {
      columns: [{ key: 'name', label: 'Name' }, { key: 'value', label: 'Value' }],
      rows: [{ name: 'token', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' }]
    })
  );
  const payload = result.payload as TableGadgetPayload;
  assert.equal(payload.rows[0].value, '[redacted]');
  assert.equal(result.redacted, true);
});

test('redaction keeps the key name so the user can tell what was masked', () => {
  const outcome = redactSecrets('api_key = "abcdef0123456789abcdef"');
  assert.equal(outcome.text, 'api_key = [redacted]');
  assert.deepEqual(outcome.hits, ['keyed-secret']);
  // A string with no secret must come back byte-identical.
  assert.equal(redactSecrets('just some prose').text, 'just some prose');
});

test('refuses an artifact path that escapes the workspace', () => {
  const error = expectError(envelope('artifact', { title: 'Files', artifacts: [{ name: 'x', path: '../../etc/passwd' }] }));
  assert.equal(error.path, 'payload.artifacts[0].path');
});

test('validates artifact handover metadata and item categories', () => {
  const payload = {
    title: 'Verification & Delivery',
    artifacts: [
      {
        name: 'Report',
        path: 'output/report.html',
        category: 'report',
        verdict: 'passed'
      },
      {
        name: 'Visual snapshot',
        path: 'output/snapshot.png',
        category: 'evidence',
        verdict: 'passed'
      }
    ],
    handover: {
      verdict: 'passed',
      testSummary: { total: 10, passed: 10, failed: 0, skipped: 0 },
      gitRef: 'feat/handover',
      nextSteps: 'Ready for merge',
      requiresSignoff: true
    }
  };

  const validated = expectOk(envelope('artifact', payload));
  assert.equal((validated.payload as any).title, 'Verification & Delivery');
  assert.equal((validated.payload as any).handover.verdict, 'passed');
  assert.equal((validated.payload as any).handover.testSummary.passed, 10);
  assert.equal((validated.payload as any).artifacts[0].category, 'report');

  const fallback = gadgetFallbackText(validated);
  assert.ok(fallback.includes('[report] (passed) Report — output/report.html'));
  assert.ok(fallback.includes('Verdict: PASSED'));
  assert.ok(fallback.includes('Tests: 10/10 passed'));
  assert.ok(fallback.includes('Git ref: feat/handover'));
  assert.ok(fallback.includes('Next steps: Ready for merge'));
  assert.ok(fallback.includes('Requires sign-off: yes'));
});

test('refuses invalid category, verdict, or testSummary numbers', () => {
  assert.equal(
    expectError(
      envelope('artifact', {
        title: 'Files',
        artifacts: [{ name: 'x', path: 'out.txt', category: 'invalid-cat' }]
      })
    ).path,
    'payload.artifacts[0].category'
  );

  assert.equal(
    expectError(
      envelope('artifact', {
        title: 'Files',
        artifacts: [{ name: 'x', path: 'out.txt', verdict: 'super-pass' }]
      })
    ).path,
    'payload.artifacts[0].verdict'
  );

  assert.equal(
    expectError(
      envelope('artifact', {
        title: 'Files',
        artifacts: [{ name: 'x', path: 'out.txt' }],
        handover: { verdict: 'maybe' }
      })
    ).path,
    'payload.handover.verdict'
  );

  assert.equal(
    expectError(
      envelope('artifact', {
        title: 'Files',
        artifacts: [{ name: 'x', path: 'out.txt' }],
        handover: { testSummary: { total: -1, passed: 0, failed: 0 } }
      })
    ).path,
    'payload.handover.testSummary.total'
  );
});

test('refuses an expiry that precedes issue, and a self-superseding gadget', () => {
  assert.equal(
    expectError(envelope('choice', CHOICE_PAYLOAD, { expiresAt: '2026-09-13T09:00:00.000Z' })).path,
    'expiresAt'
  );
  assert.equal(
    expectError(envelope('choice', CHOICE_PAYLOAD, { supersedes: 'gadget-choice' })).path,
    'supersedes'
  );
});

test('coerceGadgetBlock always yields a renderable block', () => {
  const good = coerceGadgetBlock(envelope('choice', CHOICE_PAYLOAD), 'block-1');
  assert.equal(good.type, 'gadget');

  const bad = coerceGadgetBlock({ version: 1, kind: 'nope' }, 'block-2');
  assert.equal(bad.type, 'fallback');
  if (bad.type !== 'fallback') throw new Error('unreachable');
  assert.equal(bad.reason?.code, 'unsupported-kind');
  assert.ok(bad.text.length > 0);

  // A producer's own words describe the decision; our error only describes the
  // failure — so the producer's text wins when it exists.
  const withText = coerceGadgetBlock({ version: 1, kind: 'nope', fallbackText: 'Choose a provider.' }, 'block-3');
  assert.equal(withText.type === 'fallback' && withText.text, 'Choose a provider.');
});

// ── Action values ────────────────────────────────────────────────────────

function action(overrides: Partial<GadgetAction> = {}): GadgetAction {
  return {
    version: GADGET_CONTRACT_VERSION,
    gadgetId: 'gadget-choice',
    actionId: 'submit',
    scope: SCOPE,
    idempotencyKey: 'key-1',
    correlationId: 'corr-1',
    submittedAt: '2026-09-13T10:01:00.000Z',
    value: { kind: 'choice', selected: 'local' },
    ...overrides
  };
}

test('accepts a valid choice and refuses one that is not on offer', () => {
  const gadget = expectOk(envelope('choice', CHOICE_PAYLOAD));
  assert.equal(validateGadgetActionValue(gadget, action()), undefined);
  const error = validateGadgetActionValue(gadget, action({ value: { kind: 'choice', selected: 'ghost' } }));
  assert.equal(error?.code, 'value-invalid');
});

test('refuses a selection of a disabled option, with the reason', () => {
  const gadget = expectOk(
    envelope('choice', {
      question: 'Pick',
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabledReason: 'not installed' }]
    })
  );
  const error = validateGadgetActionValue(gadget, action({ value: { kind: 'choice', selected: 'b' } }));
  assert.match(error?.message ?? '', /not installed/);
  assert.equal(error?.retryable, false);
});

test('refuses multi-select against a single-choice gadget', () => {
  const gadget = expectOk(envelope('choice', CHOICE_PAYLOAD));
  const error = validateGadgetActionValue(gadget, action({ value: { kind: 'selection', selected: ['local', 'handoff'] } }));
  assert.equal(error?.code, 'value-invalid');
  const multi = expectOk(envelope('choice', { ...CHOICE_PAYLOAD, multiple: true }));
  assert.equal(validateGadgetActionValue(multi, action({ value: { kind: 'selection', selected: ['local', 'handoff'] } })), undefined);
});

test('refuses an action the gadget never offered', () => {
  const gadget = expectOk(envelope('choice', CHOICE_PAYLOAD));
  assert.equal(validateGadgetActionValue(gadget, action({ actionId: 'sneaky' }))?.code, 'unknown-action');
});

test('enforces required, typed and bounded form fields', () => {
  const gadget = expectOk(
    envelope('form', {
      title: 'Release notes',
      fields: [
        { name: 'summary', label: 'Summary', type: 'text', required: true, maxLength: 10 },
        { name: 'count', label: 'Count', type: 'number', min: 1, max: 5 },
        { name: 'channel', label: 'Channel', type: 'select', options: [{ value: 'beta', label: 'Beta' }] }
      ]
    })
  );
  const submit = (fields: Record<string, string | number | boolean>) =>
    validateGadgetActionValue(gadget, action({ gadgetId: 'gadget-form', value: { kind: 'form', fields } }));

  assert.equal(submit({ summary: 'ok' }), undefined);
  assert.match(submit({})?.message ?? '', /Summary.*required/);
  assert.match(submit({ summary: 'far too long to fit' })?.message ?? '', /longer than 10/);
  assert.match(submit({ summary: 'ok', count: 9 })?.message ?? '', /at most 5/);
  assert.match(submit({ summary: 'ok', channel: 'stable' })?.message ?? '', /offered options/);
  assert.match(submit({ summary: 'ok', ghost: 'x' })?.message ?? '', /not a field/);
});

test('a conflict gadget needs every conflict resolved to a known side', () => {
  const gadget = expectOk(
    envelope('conflict', {
      title: 'Resolve',
      conflicts: [{ id: 'c1', label: 'README', ours: 'a', theirs: 'b' }]
    })
  );
  const submit = (fields: Record<string, string>) =>
    validateGadgetActionValue(gadget, action({ gadgetId: 'gadget-conflict', value: { kind: 'form', fields } }));
  assert.equal(submit({ c1: 'ours' }), undefined);
  assert.match(submit({})?.message ?? '', /has not been resolved/);
  assert.match(submit({ c1: 'mine' })?.message ?? '', /"ours" or "theirs"/);
});

test('narrows action values arriving over IPC', () => {
  assert.equal(isGadgetActionValue({ kind: 'choice', selected: 'a' }), true);
  assert.equal(isGadgetActionValue({ kind: 'choice', selected: 5 }), false);
  assert.equal(isGadgetActionValue({ kind: 'form', fields: { a: 1, b: 'x', c: true } }), true);
  assert.equal(isGadgetActionValue({ kind: 'form', fields: { a: { nested: true } } }), false);
  assert.equal(isGadgetActionValue({ kind: 'teleport' }), false);
  assert.equal(isGadgetActionValue(null), false);
});

// ── Fallback rendering ───────────────────────────────────────────────────

test('a table falls back to aligned columns, not a description of a table', () => {
  const gadget = expectOk(
    envelope('table', {
      title: 'Checks',
      columns: [{ key: 'check', label: 'Check' }, { key: 'passed', label: 'Passed' }],
      rows: [{ check: 'lint', passed: true }, { check: 'unit', passed: false }]
    })
  );
  const text = gadgetFallbackText(gadget);
  assert.match(text, /Check {2}Passed/);
  assert.match(text, /lint {3}yes/);
  assert.match(text, /unit {3}no/);
});

test('a chart falls back to its numbers', () => {
  const gadget = expectOk(
    envelope('chart', {
      title: 'Duration',
      chartKind: 'line',
      series: [{ label: 'build', points: [{ x: 1, y: 10 }, { x: 2, y: 30 }] }]
    })
  );
  assert.match(gadgetFallbackText(gadget), /build: 2 points, min 10, max 30, last 30/);
});

test('the action list is appended for a reader who must answer in prose', () => {
  const gadget = expectOk(
    envelope('confirmation', { question: 'Delete the branch?' }, {
      actions: [
        { actionId: 'yes', label: 'Delete', effect: 'mutating', gate: 'git.branch.delete', danger: true },
        { actionId: 'no', label: 'Keep', effect: 'informational' }
      ]
    })
  );
  assert.match(gadgetFallbackWithActions(gadget), /Available: Delete \(destructive\) · Keep/);
});

// ── Provider message parsing ─────────────────────────────────────────────

const PARSE_OPTIONS = { scope: SCOPE, issuedAt: '2026-09-13T10:00:00.000Z', idPrefix: 'msg-1' };

test('splits a provider message into ordered markdown and gadget blocks', () => {
  const text = [
    'Here is what I found.',
    '',
    '```praxis-gadget',
    JSON.stringify({ kind: 'choice', payload: CHOICE_PAYLOAD, actions: [{ actionId: 'go', label: 'Go', effect: 'informational' }] }),
    '```',
    '',
    'Let me know.'
  ].join('\n');

  const parsed = parseChatBlocks(text, PARSE_OPTIONS);
  assert.equal(parsed.containsGadget, true);
  assert.equal(parsed.malformed, 0);
  assert.deepEqual(parsed.blocks.map(block => block.type), ['markdown', 'gadget', 'markdown']);
  assert.equal(parsed.blocks[0].type === 'markdown' && parsed.blocks[0].markdown, 'Here is what I found.');
  assert.equal(parsed.blocks[2].type === 'markdown' && parsed.blocks[2].markdown, 'Let me know.');
});

test('the host stamps scope and issue time, overwriting whatever the producer sent', () => {
  // A model that could name its own scope could aim an approval at another
  // project, so these are overwritten rather than merged.
  const text = [
    '```praxis-gadget',
    JSON.stringify({
      kind: 'choice',
      payload: CHOICE_PAYLOAD,
      actions: [],
      scope: { hostId: 'attacker', sessionId: 'other-session', projectId: 'other-project' },
      issuedAt: '1999-01-01T00:00:00.000Z'
    }),
    '```'
  ].join('\n');

  const parsed = parseChatBlocks(text, PARSE_OPTIONS);
  const gadget = parsed.blocks[0].type === 'gadget' ? (parsed.blocks[0].gadget as Record<string, unknown>) : undefined;
  assert.deepEqual(gadget?.scope, SCOPE);
  assert.equal(gadget?.issuedAt, '2026-09-13T10:00:00.000Z');

  // …and the stamped envelope still validates end to end.
  const block = coerceGadgetBlock(gadget, 'b1');
  assert.equal(block.type, 'gadget');
  assert.equal(block.type === 'gadget' && block.gadget.scope.hostId, SCOPE.hostId);
});

test('a malformed fence survives as visible code instead of vanishing', () => {
  const text = ['```praxis-gadget', '{ not json at all', '```'].join('\n');
  const parsed = parseChatBlocks(text, PARSE_OPTIONS);
  assert.equal(parsed.containsGadget, true);
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.blocks.length, 1);
  assert.equal(parsed.blocks[0].type, 'markdown');
  assert.match(parsed.blocks[0].type === 'markdown' ? parsed.blocks[0].markdown : '', /not json at all/);
});

test('re-parsing the same message mints the same IDs, so publishing is idempotent', () => {
  const text = ['```praxis-gadget', JSON.stringify({ kind: 'choice', payload: CHOICE_PAYLOAD, actions: [] }), '```'].join('\n');
  const first = parseChatBlocks(text, PARSE_OPTIONS);
  const second = parseChatBlocks(text, { ...PARSE_OPTIONS, issuedAt: '2026-09-13T11:00:00.000Z' });
  assert.equal(first.blocks[0].blockId, second.blocks[0].blockId);
  const idOf = (parsed: typeof first) =>
    parsed.blocks[0].type === 'gadget' ? (parsed.blocks[0].gadget as Record<string, unknown>).gadgetId : undefined;
  assert.equal(idOf(first), idOf(second));
});

test('a producer-supplied gadget ID is kept, so a streaming update can supersede', () => {
  const text = [
    '```praxis-gadget',
    JSON.stringify({ gadgetId: 'run-progress', kind: 'progress', payload: { title: 'Build', status: 'running' }, actions: [] }),
    '```'
  ].join('\n');
  const parsed = parseChatBlocks(text, PARSE_OPTIONS);
  const gadget = parsed.blocks[0].type === 'gadget' ? (parsed.blocks[0].gadget as Record<string, unknown>) : undefined;
  assert.equal(gadget?.gadgetId, 'run-progress');
});

test('text with no fence parses to a single markdown block and skips the work', () => {
  assert.equal(mayContainGadget('just prose'), false);
  const parsed = parseChatBlocks('just prose', PARSE_OPTIONS);
  assert.equal(parsed.containsGadget, false);
  assert.deepEqual(parsed.blocks, [{ type: 'markdown', markdown: 'just prose', blockId: `${PARSE_OPTIONS.idPrefix}-md-0` }]);
});

test('re-parsing prose with gadgets produces stable block IDs for markdown and gadget blocks', () => {
  const text = [
    'Leading prose.',
    '```praxis-gadget',
    JSON.stringify({ kind: 'choice', payload: CHOICE_PAYLOAD, actions: [] }),
    '```',
    'Trailing prose.'
  ].join('\n');
  const first = parseChatBlocks(text, PARSE_OPTIONS);
  const second = parseChatBlocks(text, { ...PARSE_OPTIONS, issuedAt: '2026-09-13T12:00:00.000Z' });
  assert.equal(first.blocks.length, 3);
  assert.deepEqual(
    first.blocks.map(b => b.blockId),
    second.blocks.map(b => b.blockId)
  );
  assert.deepEqual(
    first.blocks.map(b => b.blockId),
    [`${PARSE_OPTIONS.idPrefix}-md-0`, `${PARSE_OPTIONS.idPrefix}-1`, `${PARSE_OPTIONS.idPrefix}-md-1`]
  );
});

test('several gadgets in one message keep their order and get distinct IDs', () => {
  const fence = (kind: string, payload: unknown) =>
    ['```praxis-gadget', JSON.stringify({ kind, payload, actions: [] }), '```'].join('\n');
  const text = [fence('choice', CHOICE_PAYLOAD), 'and also', fence('progress', { title: 'Build', status: 'running' })].join('\n\n');
  const parsed = parseChatBlocks(text, PARSE_OPTIONS);
  assert.deepEqual(parsed.blocks.map(block => block.type), ['gadget', 'markdown', 'gadget']);
  const ids = parsed.blocks.filter(block => block.type === 'gadget').map(block => block.blockId);
  assert.equal(new Set(ids).size, 2);
});

test('an approval gadget may offer a decline, but must offer an approval', () => {
  const approvalPayload = { title: 'Ship it?', summary: 'All checks passed.', gate: 'deployment.staging' };

  // Declining is an ordinary informational action — refusing to allow one would
  // make "Reject" unexpressible on the very surface that most needs it.
  const withDecline = expectOk(
    envelope('approval', approvalPayload, {
      actions: [
        { actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'deployment.staging' },
        { actionId: 'reject', label: 'Reject', effect: 'informational' }
      ]
    })
  );
  assert.equal(withDecline.actions.length, 2);

  const declineOnly = expectError(
    envelope('approval', approvalPayload, { actions: [{ actionId: 'reject', label: 'Reject', effect: 'informational' }] })
  );
  assert.equal(declineOnly.code, 'schema-invalid');
  assert.match(declineOnly.message, /at least one approval action/);
});

test('an approval gadget carries the workflow node it settles, for a real run', () => {
  const envelopeWithNode = expectOk(
    envelope(
      'approval',
      { title: 'Ship it?', summary: 'All checks passed.', gate: 'review', nodeId: 'approve-a' },
      { actions: [{ actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'review' }] }
    )
  );
  assert.equal((envelopeWithNode.payload as { nodeId?: string }).nodeId, 'approve-a');

  // A fixture or standalone approval never issued against a run has no node to name.
  const withoutNode = expectOk(
    envelope(
      'approval',
      { title: 'Ship it?', summary: 'All checks passed.', gate: 'deployment.staging' },
      { actions: [{ actionId: 'approve', label: 'Approve', effect: 'approval', gate: 'deployment.staging' }] }
    )
  );
  assert.equal((withoutNode.payload as { nodeId?: string }).nodeId, undefined);
});
