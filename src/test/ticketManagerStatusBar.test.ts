import * as assert from 'assert';
import {
  buildTicketManagerStatusPresentation,
  getBackendModeLabel
} from '../views/ticketManagerStatusBar';

suite('TicketManagerStatusBar', () => {
  test('shows setup warning when no providers are configured', () => {
    const presentation = buildTicketManagerStatusPresentation({
      providerCount: 0,
      connection: undefined,
      aiProviders: [],
      activeProvider: 'none',
      lastError: undefined,
      isChecking: false
    });

    assert.strictEqual(presentation.tone, 'warning');
    assert.strictEqual(presentation.text, '$(ticket-manager-ticket) $(warning)');
    assert.ok(presentation.accessibilityLabel.includes('no providers'));
    assert.ok(presentation.tooltipMarkdown.includes('No providers configured\\.'));
    assert.ok(presentation.tooltipMarkdown.includes('Configure AI'));
    assert.ok(presentation.tooltipMarkdown.includes('Open Ticket Manager Settings'));
  });

  test('shows provider count and configured AI in healthy state', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: 'jiracloud',
      providerCount: 3,
      connection: {
        status: 'ok',
        message: 'Connected. 3 accessible project(s) found.',
        toolCount: 8,
        projectCount: 3,
        serverName: 'workspace-jira'
      },
      aiProviders: ['openai'],
      activeProvider: 'openai',
      lastError: undefined,
      isChecking: false
    });

    assert.strictEqual(getBackendModeLabel('jiracloud'), 'Jira Cloud');
    assert.strictEqual(presentation.tone, 'ok');
    assert.strictEqual(presentation.text, '$(ticket-manager-ticket)');
    assert.ok(presentation.accessibilityLabel.includes('3 providers'));
    assert.ok(presentation.accessibilityLabel.includes('OpenAI'));
    assert.ok(presentation.tooltipMarkdown.includes('Connected to 3 providers\\.'));
    assert.ok(presentation.tooltipMarkdown.includes('Configured with OpenAI\\.'));
    assert.ok(!presentation.tooltipMarkdown.includes('Projects: 3'));
  });

  test('last error takes precedence over healthy connection state', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: 'livefolder',
      providerCount: 2,
      connection: {
        status: 'ok',
        message: 'Live Folder active.',
        toolCount: 0,
        projectCount: 1
      },
      aiProviders: ['claude'],
      activeProvider: 'claude',
      lastError: 'Failed to refresh issue details.',
      isChecking: false
    });

    assert.strictEqual(presentation.tone, 'error');
    assert.strictEqual(presentation.text, '$(ticket-manager-ticket) $(error)');
    assert.ok(presentation.accessibilityLabel.includes('2 providers'));
    assert.ok(presentation.accessibilityLabel.includes('Claude'));
    assert.ok(presentation.tooltipMarkdown.includes('Connected to 2 providers\\.'));
    assert.ok(presentation.tooltipMarkdown.includes('Last error: Failed to refresh issue details\\.'));
  });

  test('surfaces paused sessions and pending approvals as attention state', () => {
    const presentation = buildTicketManagerStatusPresentation({
      backendMode: 'jiracloud',
      providerCount: 1,
      connection: {
        status: 'ok',
        message: 'Connected.',
        toolCount: 4,
        projectCount: 2
      },
      aiProviders: ['copilot-cli'],
      activeProvider: 'copilot-cli',
      activeSessionCount: 3,
      approvalSessionCount: 1,
      pausedSessionCount: 2,
      lastError: undefined,
      isChecking: false
    });

    assert.strictEqual(presentation.tone, 'warning');
    assert.strictEqual(presentation.text, '$(ticket-manager-ticket) $(warning)');
    assert.ok(presentation.accessibilityLabel.includes('1 provider'));
    assert.ok(presentation.accessibilityLabel.includes('1 approval'));
    assert.ok(presentation.accessibilityLabel.includes('2 paused'));
    assert.ok(presentation.tooltipMarkdown.includes('Connected to 1 provider\\.'));
    assert.ok(presentation.accessibilityLabel.includes('GitHub Copilot SDK'));
    assert.ok(presentation.tooltipMarkdown.includes('Configured with GitHub Copilot SDK\\.'));
    assert.ok(presentation.tooltipMarkdown.includes('Active sessions: 3'));
    assert.ok(presentation.tooltipMarkdown.includes('Approval required: 1'));
    assert.ok(presentation.tooltipMarkdown.includes('Paused sessions: 2'));
    assert.ok(presentation.tooltipMarkdown.includes('Open Sessions'));
  });
});
