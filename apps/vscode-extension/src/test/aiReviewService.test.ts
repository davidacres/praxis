import * as assert from 'node:assert';
import {
  extractClarificationQuestions,
  normalizeClarificationCommentBody,
  parseCopilotImplementationReadinessAssessment,
  parseTaskDesignerFlowRecommendation,
  type TaskDesignerRecommendationNode
} from '@praxis/core';

suite('aiReviewService clarification comment sanitization', () => {
  test('keeps only numbered clarification questions', () => {
    const body = normalizeClarificationCommentBody(`Implementation is blocked because several details are missing.
Questions:
1. Which environment should this target?
2. What tenant should be used?`);

    assert.strictEqual(
      body,
      '1. Which environment should this target?\n2. What tenant should be used?'
    );
  });

  test('strips tool traces and reasoning from Copilot clarification output', () => {
    const questions = extractClarificationQuestions(`Thought: I should inspect the repo first.
Tool: read_file src/config.ts
Tool result: found staging references
Questions:
1. Which environment should this target?
2. Should the existing feature flag remain enabled?`);

    assert.deepStrictEqual(questions, [
      'Which environment should this target?',
      'Should the existing feature flag remain enabled?'
    ]);
  });

  test('adds a question mark for question-like numbered lines missing punctuation', () => {
    const body = normalizeClarificationCommentBody(`1. Which environment should this target
2. What tenant should be used`);

    assert.strictEqual(
      body,
      '1. Which environment should this target?\n2. What tenant should be used?'
    );
  });

  test('parses a structured copilot readiness assessment result', () => {
    const assessment = parseCopilotImplementationReadinessAssessment([
      '```json',
      '{',
      '  "status": "ready",',
      '  "workflowReference": "add-edit-dotnet-web-api",',
      '  "comment": ""',
      '}',
      '```'
    ].join('\n'));

    assert.deepStrictEqual(assessment, {
      status: 'ready',
      workflowReference: 'add-edit-dotnet-web-api',
      clarificationComment: undefined
    });
  });

  test('parses a clarification assessment comment when workflow is missing', () => {
    const assessment = parseCopilotImplementationReadinessAssessment([
      '```json',
      '{',
      '  "status": "needs_clarification",',
      '  "workflowReference": "",',
      '  "comment": "Please specify the workflow pack for this ticket in Praxis or add a Jira comment such as Workflow pack: add-edit-dotnet-web-api."',
      '}',
      '```'
    ].join('\n'));

    assert.deepStrictEqual(assessment, {
      status: 'needs_clarification',
      workflowReference: undefined,
      clarificationComment: 'Please specify the workflow pack for this ticket in Praxis or add a Jira comment such as Workflow pack: add-edit-dotnet-web-api.'
    });
  });
});

suite('aiReviewService task designer recommendation parsing', () => {
  const nodes: TaskDesignerRecommendationNode[] = [
    {
      id: 'n1',
      issueKey: 'APP-1',
      summary: 'First',
      issueType: 'Story',
      status: 'To Do',
      projectKey: 'APP'
    },
    {
      id: 'n2',
      issueKey: 'APP-2',
      summary: 'Second',
      issueType: 'Story',
      status: 'To Do',
      projectKey: 'APP'
    },
    {
      id: 'n3',
      issueKey: 'APP-3',
      summary: 'Third',
      issueType: 'Story',
      status: 'To Do',
      projectKey: 'APP'
    }
  ];

  test('parses valid ordered node recommendations and preserves rationale', () => {
    const recommendation = parseTaskDesignerFlowRecommendation([
      '```json',
      '{',
      '  "orderedNodeIds": ["n2", "n1", "n3"],',
      '  "connectors": [',
      '    { "sourceNodeId": "n2", "targetNodeId": "n1" },',
      '    { "sourceNodeId": "n1", "targetNodeId": "n3" }',
      '  ],',
      '  "rationale": "Start with shared dependency setup."',
      '}',
      '```'
    ].join('\n'), nodes);

    assert.deepStrictEqual(recommendation, {
      orderedNodeIds: ['n2', 'n1', 'n3'],
      connectors: [
        { sourceNodeId: 'n2', targetNodeId: 'n1' },
        { sourceNodeId: 'n1', targetNodeId: 'n3' }
      ],
      rationale: 'Start with shared dependency setup.'
    });
  });

  test('fills missing nodes and derives connectors when omitted', () => {
    const recommendation = parseTaskDesignerFlowRecommendation([
      '```json',
      '{',
      '  "orderedNodeIds": ["n3"]',
      '}',
      '```'
    ].join('\n'), nodes);

    assert.deepStrictEqual(recommendation, {
      orderedNodeIds: ['n3', 'n1', 'n2'],
      connectors: [
        { sourceNodeId: 'n3', targetNodeId: 'n1' },
        { sourceNodeId: 'n1', targetNodeId: 'n2' }
      ],
      rationale: undefined
    });
  });
});
