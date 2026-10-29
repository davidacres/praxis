import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { AgentEventSummary, AgentSessionRecord } from '../agentTypes';
import { classifyPromptIntent } from './promptSignals';
import { evaluateSessionOrPrompt } from './sessionFeedbackScorer';
import { derivePriorContext, extractPromptIdentifiers, groundPromptTerms, pickTestCommand, rankFileCandidates } from './workspaceGrounding';
import { checkedClarity } from './promptClarityFixtures';
import type { FeedbackWorkspaceHints } from './feedbackTypes';

const HINTS: FeedbackWorkspaceHints = {
  changedFiles: [
    'renderer/src/ai/SessionPromptScoreBar.tsx',
    'renderer/src/ai/SessionFeedbackPanel.tsx',
    'renderer/src/theme.css'
  ],
  testFiles: ['main/e2e/sessionFeedback.spec.ts', 'main/e2e/promptScoreBar.spec.ts', 'main/e2e/board.spec.ts'],
  packageScripts: ['build', 'check-types', 'test']
};

function session(events: AgentEventSummary[], overrides?: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    issueKey: 'FX-BF-112',
    sessionId: 'sess-v2',
    state: 'completed',
    toolMode: 'full',
    mode: 'chat',
    activeSkills: [],
    taskDefinition: { kind: 'general', goal: 'fix the score bar alignment in SessionPromptScoreBar.tsx', scope: '', definitionOfDone: '' },
    events,
    stepCount: events.length,
    ...overrides
  } as AgentSessionRecord;
}

describe('feedback rubric v2 — intent, context, grounding, root causes', () => {
  it('classifies prompt intent before grading', () => {
    assert.equal(classifyPromptIntent('how will this feature be used?', false), 'question');
    assert.equal(classifyPromptIntent('how do I fix the flaky test', false), 'question');
    assert.equal(classifyPromptIntent('can you add a dismiss button to the bar?', false), 'feature');
    assert.equal(classifyPromptIntent('fix the truncated headline in the score bar', false), 'bugfix');
    assert.equal(classifyPromptIntent('commit all changes', true), 'follow-up');
    assert.equal(classifyPromptIntent('run the e2e test again and commit all changes if it passes', true), 'follow-up');
    assert.equal(classifyPromptIntent('review the diff for security issues', false), 'review');
    // An imperative is a request even without a code verb; being short is not being a follow-up
    assert.equal(classifyPromptIntent('put the thing in the box', false), 'feature');
    assert.equal(classifyPromptIntent('put the thing in the box', true), 'feature');
  });

  it('scores vague semantic checklist answers on the first or a later turn', () => {
    for (const priorContext of [undefined, { turnCount: 2, touchedPaths: ['src/A.tsx'] }]) {
      const report = evaluateSessionOrPrompt({ kind: 'prompt-readiness', promptText: 'put the thing in the box',
        toolMode: 'full', priorContext, clarity: checkedClarity({ target: 'no', outcome: 'no', done: 'no', ambiguity: 'yes' }) });
      assert.ok(report.overallScore <= 45);
      assert.ok(report.findings.some(f => f.id === 'clarity-target'));
      assert.ok(report.findings.some(f => f.id === 'clarity-ambiguity'));
      assert.equal(report.projectedScore, report.overallScore);
    }
  });

  it('does not fabricate semantic findings without a model assessment', () => {
    const report = evaluateSessionOrPrompt({ kind: 'prompt-readiness', promptText: 'put the thing in the box', toolMode: 'full' });
    assert.deepEqual(report.findings, []);
  });

  it('does not grade a question on file anchors or test commands', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'how will this feature be used?',
      toolMode: 'read-only'
    });
    assert.equal(report.intent, 'question');
    assert.deepEqual(report.findings, []);
  });

  it('stays quiet on a follow-up turn that inherits session context', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'run the e2e test again and commit all changes if it passes',
      toolMode: 'full',
      priorContext: { turnCount: 1, touchedPaths: ['a.tsx', 'b.tsx'], issueKey: 'FX-BF-112' },
      workspaceHints: HINTS
    });
    assert.equal(report.intent, 'follow-up');
    assert.deepEqual(report.findings, []);
    assert.equal(report.contextInheritance?.touchedPaths.length, 2);
    assert.equal(report.contextInheritance?.issueKey, 'FX-BF-112');
  });

  it('still flags the read-only blocker on a follow-up turn', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'now fix it',
      toolMode: 'read-only',
      priorContext: { turnCount: 2, touchedPaths: ['a.tsx'] }
    });
    assert.deepEqual(report.findings.map(f => f.id), ['prompt-tool-mode-conflict']);
  });

  it('grounds scope and verification fixes in real workspace files and tests', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'prompt-readiness',
      promptText: 'fix the score pill alignment and truncated headline in the prompt score bar',
      clarity: checkedClarity({ target: 'partial', done: 'no' }),
      toolMode: 'full',
      workspaceHints: HINTS
    });
    const anchor = report.findings.find(f => f.id === 'clarity-target');
    assert.equal(anchor?.remediation.kind, 'pin-file');
    assert.equal(anchor?.remediation.targetId, 'renderer/src/ai/SessionPromptScoreBar.tsx');
    const verify = report.findings.find(f => f.id === 'clarity-done');
    assert.equal(verify?.remediation.kind, 'add-test-command');
    assert.equal(verify?.remediation.targetId, 'npx playwright test e2e/promptScoreBar.spec.ts');
    // The suggestion weaves the concrete fixes into the sentence — no boilerplate block
    assert.equal(
      report.suggestedPrompt,
      'fix the score pill alignment and truncated headline in the prompt score bar in @renderer/src/ai/SessionPromptScoreBar.tsx and verify with `npx playwright test e2e/promptScoreBar.spec.ts`.'
    );
  });

  it('falls back to the workspace typecheck script when no test file matches', () => {
    assert.deepEqual(pickTestCommand('rename the theme tokens', HINTS), { label: 'npm run check-types', command: 'npm run check-types' });
    assert.deepEqual(rankFileCandidates('rename the theme tokens', HINTS).map(c => c.path), ['renderer/src/theme.css']);
    assert.deepEqual(rankFileCandidates('fix SessionPromptScoreBar.tsx', HINTS).map(c => c.path), []);
  });

  it('derives prior context from a session transcript', () => {
    const prior = derivePriorContext(session([
      { timestamp: 't1', type: 'tool_complete', summary: 'w', data: { toolName: 'write_file', ok: true, fileChanges: [{ path: 'x/A.tsx' }] } },
      { timestamp: 't2', type: 'user_input_completed', summary: 'next' }
    ]));
    assert.equal(prior.turnCount, 2);
    assert.deepEqual(prior.touchedPaths, ['x/A.tsx']);
    assert.equal(prior.issueKey, 'FX-BF-112');
    assert.deepEqual(prior.recentMessages?.map(message => message.role), ['user', 'user']);
    assert.equal(prior.recentMessages?.at(-1)?.text, 'next');
  });

  it('names an unresolved test failure as a root cause', () => {
    const report = evaluateSessionOrPrompt({
      kind: 'session-execution',
      promptText: '',
      session: session([
        { timestamp: 't1', type: 'tool_start', summary: 'read', data: { toolName: 'read_file', callId: 'r1', args: { path: 'src/A.tsx' } } },
        { timestamp: 't2', type: 'tool_complete', summary: 'read', data: { toolName: 'read_file', callId: 'r1', ok: true } },
        { timestamp: 't3', type: 'tool_start', summary: 'edit', data: { toolName: 'edit_file', callId: 'e1', args: { path: 'src/A.tsx' } } },
        { timestamp: 't4', type: 'tool_complete', summary: 'edit', data: { toolName: 'edit_file', callId: 'e1', ok: true, fileChanges: [{ path: 'src/A.tsx' }] } },
        { timestamp: 't5', type: 'tool_start', summary: 'test', data: { toolName: 'run_command', kind: 'shell', callId: 's1', args: { command: 'npm test' } } },
        { timestamp: 't6', type: 'tool_complete', summary: 'test', data: { toolName: 'run_command', kind: 'shell', callId: 's1', ok: false, output: '1 failing: expected 2 got 3' } }
      ])
    });
    const ids = report.findings.map(f => f.id);
    assert.ok(ids.includes('outcome-unresolved-failure'));
    // Arguments come from the start event even though the outcome is on the completion
    assert.ok(!ids.includes('tool-blind-edits'));
    const unresolved = report.findings.find(f => f.id === 'outcome-unresolved-failure')!;
    assert.match(unresolved.title, /`npm test` failed and was never fixed/);
    assert.match(unresolved.evidence, /expected 2 got 3/);
    assert.deepEqual(unresolved.stepIndices, [6]);
  });

  it('flags thrashing on one file and carries dimension signals and a diagnosis', () => {
    const edits: AgentEventSummary[] = [
      { timestamp: 't0', type: 'tool_complete', summary: 'read', data: { toolName: 'read_file', ok: true, args: { path: 'src/B.ts' } } }
    ];
    for (let i = 1; i <= 5; i += 1) {
      edits.push({ timestamp: `t${i}`, type: 'tool_complete', summary: 'edit', data: { toolName: 'edit_file', ok: true, args: { path: 'src/B.ts' }, fileChanges: [{ path: 'src/B.ts' }] } });
    }
    const report = evaluateSessionOrPrompt({ kind: 'session-execution', promptText: '', session: session(edits) });
    assert.ok(report.findings.some(f => f.id === 'tool-file-thrash:B.ts'));
    const outcome = report.dimensions.find(d => d.dimension === 'outcome-verification');
    assert.ok(outcome?.signals?.some(s => s.label === '! No test/build after step #6'));
    assert.ok(report.diagnosis?.headline.startsWith('Completed with'));
    assert.match(report.suggestedPrompt, /^Follow up on the previous turn:\n- /);
  });

  describe('grounding prompts in the workspace', () => {
    const TRACKED: FeedbackWorkspaceHints = {
      changedFiles: [],
      testFiles: ['e2e/sessionFeedback.spec.ts', 'e2e/iconButtonTooltips.spec.ts'],
      packageScripts: ['check-types'],
      trackedFiles: [
        'renderer/src/ai/SessionFeedbackPanel.tsx',
        'renderer/src/ai/SessionScorecardPanel.tsx',
        'renderer/src/app/TitleBar.tsx',
        'renderer/src/ui/IconButton.tsx',
        'e2e/sessionFeedback.spec.ts',
        'e2e/iconButtonTooltips.spec.ts'
      ]
    };

    it('keeps spelling suggestions factual and independent of the clarity score', () => {
      const grounding = groundPromptTerms('make the scorcard tab bigger', TRACKED);
      assert.ok(JSON.stringify(grounding).includes('scorecard'));
    });

    it('suggests an unchanged file only when it matches as well as the prompt allows', () => {
      // "bar" alone matches TitleBar.tsx; the prompt's two grounded words do not both match it
      const hints = { ...TRACKED, trackedFiles: [...TRACKED.trackedFiles!, 'renderer/src/ai/ScoreGauge.tsx'] };
      assert.deepEqual(rankFileCandidates('fix the score bar headline', hints).map(c => c.path), []);
      assert.equal(
        rankFileCandidates('fix the session feedback panel verdict', TRACKED)[0]?.path,
        'renderer/src/ai/SessionFeedbackPanel.tsx'
      );
      // A changed file still qualifies on one shared word
      assert.deepEqual(
        rankFileCandidates('fix the title', { ...TRACKED, changedFiles: ['renderer/src/app/TitleBar.tsx'] }).map(c => c.path),
        ['renderer/src/app/TitleBar.tsx']
      );
      // Tests meet the same bar: "button" alone does not make iconButtonTooltips.spec.ts relevant
      assert.deepEqual(pickTestCommand('add a retry button to the sync panel', TRACKED), { label: 'npm run check-types', command: 'npm run check-types' });
    });

    it('checks identifiers against the code index, not file names', () => {
      assert.deepEqual(extractPromptIdentifiers('rename `scoreFn` and evaluateSessionOrPrompt to score_prompt'), ['evaluateSessionOrPrompt', 'scoreFn', 'score_prompt']);
      const hints: FeedbackWorkspaceHints = {
        ...TRACKED,
        symbols: [
          { name: 'evaluateSessionOrPromt', found: false },
          { name: 'scorePrompt', found: false }
        ]
      };
      const typo = evaluateSessionOrPrompt({
        kind: 'prompt-readiness',
        promptText: 'rename evaluateSessionOrPromt to scorePrompt',
        toolMode: 'full',
        workspaceHints: hints
      });
      const unknown = typo.findings.find(f => f.id === 'prompt-unknown-symbol')!;
      // The misspelled existing name is flagged; the new name the rename introduces is not
      assert.match(unknown.title, /`evaluateSessionOrPromt` isn't in the code index/);
      assert.doesNotMatch(unknown.title, /scorePrompt/);

      const real = evaluateSessionOrPrompt({
        kind: 'prompt-readiness',
        promptText: 'rename evaluateSessionOrPrompt to scorePrompt and update callers',
        toolMode: 'full',
        workspaceHints: { ...TRACKED, symbols: [{ name: 'evaluateSessionOrPrompt', found: true }, { name: 'scorePrompt', found: false }] }
      });
      const ids = real.findings.map(f => f.id);
      // A found symbol anchors the prompt and grounds it
      assert.ok(!ids.includes('prompt-unknown-symbol'));
      assert.ok(!ids.includes('prompt-missing-scope-anchor'));
      assert.deepEqual(groundPromptTerms('rename evaluateSessionOrPrompt', real.inventory && { ...TRACKED, symbols: [{ name: 'evaluateSessionOrPrompt', found: true }] }).matched, ['evaluateSessionOrPrompt']);
    });
  });
});
