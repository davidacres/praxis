import * as assert from 'assert';
import {
  buildTicketManagerStatusPresentation,
  getBackendModeLabel
} from '../views/ticketManagerStatusBar';

suite('TicketManagerStatusBar', () => {
  test('shows setup warning when backend is unconfigured', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: undefined,
      connection: undefined,
      aiProviders: [],
      defaultProvider: 'none',
      lastError: undefined,
      isChecking: false
    });

    assert.strictEqual(presentation.tone, 'warning');
    assert.ok(presentation.text.includes('Unconfigured'));
    assert.ok(presentation.tooltipMarkdown.includes('Configure AI'));
    assert.ok(presentation.tooltipMarkdown.includes('Open Ticket Manager Settings'));
  });

  test('shows default AI provider in healthy state', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: 'jira',
      connection: {
        status: 'ok',
        message: 'Connected. 3 accessible project(s) found.',
        toolCount: 8,
        projectCount: 3,
        serverName: 'workspace-jira'
      },
      aiProviders: ['openai', 'copilot-cli'],
      defaultProvider: 'openai',
      lastError: undefined,
      isChecking: false
    });

    assert.strictEqual(getBackendModeLabel('jira'), 'Jira');
    assert.strictEqual(presentation.tone, 'ok');
    assert.ok(presentation.text.includes('AI OpenAI'));
    assert.ok(presentation.tooltipMarkdown.includes('Default provider: OpenAI'));
  });

  test('last error takes precedence over healthy connection state', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: 'file',
      connection: {
        status: 'ok',
        message: 'File mode active.',
        toolCount: 0,
        projectCount: 1
      },
      aiProviders: ['claude'],
      defaultProvider: 'claude',
      lastError: 'Failed to refresh issue details.',
      isChecking: false
    });

    assert.strictEqual(presentation.tone, 'error');
    assert.ok(presentation.text.includes('Ticket Manager: File'));
    assert.ok(presentation.tooltipMarkdown.includes('Last error: Failed to refresh issue details\\.'));
  });
});
