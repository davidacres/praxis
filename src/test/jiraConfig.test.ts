import * as assert from 'assert';
import {
  buildJiraConnectionChoices,
  buildManualJiraConnectionChoices
} from '../config/jiraConfig';

suite('jiraConfig connection choices', () => {
  test('shows available workspace and user MCP sources before the single manual setup option', () => {
    const choices = buildJiraConnectionChoices(true, true);

    assert.deepStrictEqual(
      choices.map(choice => choice.label),
      [
        'Use Workspace MCP Configuration',
        'Use User/Profile MCP Configuration',
        'Manual Setup'
      ]
    );
  });

  test('shows only manual setup when no imported MCP sources exist', () => {
    const choices = buildJiraConnectionChoices(false, false);

    assert.deepStrictEqual(
      choices.map(choice => choice.label),
      ['Manual Setup']
    );
  });

  test('keeps existing manual preference order in the second-step manual picker', () => {
    const stdioChoices = buildManualJiraConnectionChoices('stdio');
    const httpChoices = buildManualJiraConnectionChoices('http');

    assert.deepStrictEqual(stdioChoices.map(choice => choice.label), [
      'Local Process',
      'Remote MCP Server'
    ]);
    assert.deepStrictEqual(httpChoices.map(choice => choice.label), [
      'Remote MCP Server',
      'Local Process'
    ]);
  });

  test('keeps the available imported source plus manual setup when only one MCP source exists', () => {
    assert.deepStrictEqual(
      buildJiraConnectionChoices(false, true).map(choice => choice.label),
      ['Use User/Profile MCP Configuration', 'Manual Setup']
    );
  });
});