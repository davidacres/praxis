import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IssueDetails, WorkflowTransition } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import { TrackerMcpServer } from './trackerMcpServer';

function fakeService(): {
  service: IssueTrackerService;
  comments: Array<{ issueKey: string; body: string }>;
  transitionsTriggered: Array<{ issueKey: string; transitionId: string }>;
} {
  const comments: Array<{ issueKey: string; body: string }> = [];
  const transitionsTriggered: Array<{ issueKey: string; transitionId: string }> = [];

  const transitions: WorkflowTransition[] = [
    { id: 't-1', name: 'Start Work', toStatus: 'In Progress' },
    { id: 't-2', name: 'Complete', toStatus: 'Done' }
  ];

  const service: IssueTrackerService = {
    mode: 'demo',
    async getIssue(issueKey: string) {
      return {
        key: issueKey,
        summary: `Summary of ${issueKey}`,
        issueType: 'Story',
        status: 'To Do',
        projectKey: 'TEST'
      } as IssueDetails;
    },
    async getTransitions() {
      return transitions;
    },
    async addComment(issueKey: string, body: string) {
      comments.push({ issueKey, body });
    },
    async updateIssue() {},
    async transitionIssue(issueKey: string, transitionId: string) {
      transitionsTriggered.push({ issueKey, transitionId });
    }
  } as unknown as IssueTrackerService;

  return { service, comments, transitionsTriggered };
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

test('TrackerMcpServer lists tracker tools and executes read/write tools', async () => {
  const { service, comments, transitionsTriggered } = fakeService();
  const server = new TrackerMcpServer();
  const reg = await server.register({
    service,
    toolMode: 'full'
  });

  try {
    const client = await connect(reg.url);
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name).sort();
    assert.deepEqual(toolNames, [
      'tracker_add_comment',
      'tracker_get_ticket',
      'tracker_list_transitions',
      'tracker_transition_ticket',
      'tracker_update_ticket'
    ]);

    // Test tracker_get_ticket
    const getRes = await client.callTool({ name: 'tracker_get_ticket', arguments: { issueKey: 'TEST-1' } });
    const getPayload = JSON.parse((getRes.content as Array<{ text: string }>)[0].text);
    assert.equal(getPayload.key, 'TEST-1');
    assert.equal(getPayload.summary, 'Summary of TEST-1');

    // Test tracker_add_comment
    const commentRes = await client.callTool({ name: 'tracker_add_comment', arguments: { issueKey: 'TEST-1', body: 'Work started.' } });
    assert.equal((commentRes.content as Array<{ text: string }>)[0].text.includes('Comment added'), true);
    assert.deepEqual(comments, [{ issueKey: 'TEST-1', body: 'Work started.' }]);

    // Test tracker_transition_ticket using status name resolution
    const transRes = await client.callTool({ name: 'tracker_transition_ticket', arguments: { issueKey: 'TEST-1', transitionId: 'In Progress' } });
    assert.equal((transRes.content as Array<{ text: string }>)[0].text.includes('transitioned'), true);
    assert.deepEqual(transitionsTriggered, [{ issueKey: 'TEST-1', transitionId: 't-1' }]);

    await client.close();
  } finally {
    reg.dispose();
    server.stop();
  }
});

test('TrackerMcpServer restricts write tools in read-only mode', async () => {
  const { service } = fakeService();
  const server = new TrackerMcpServer();
  const reg = await server.register({
    service,
    toolMode: 'read-only'
  });

  try {
    const client = await connect(reg.url);
    const tools = await client.listTools();
    const toolNames = tools.tools.map(t => t.name).sort();
    assert.deepEqual(toolNames, [
      'tracker_get_ticket',
      'tracker_list_transitions'
    ]);

    // Attempting to call write tool directly returns error
    const writeRes = await client.callTool({ name: 'tracker_add_comment', arguments: { issueKey: 'TEST-1', body: 'test' } });
    assert.equal(writeRes.isError, true);

    await client.close();
  } finally {
    reg.dispose();
    server.stop();
  }
});
