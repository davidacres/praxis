// SPDX-License-Identifier: MIT
//
// The mock Jira MCP server presenting the official Atlassian tool surface (getJiraIssue,
// createJiraIssue, editJiraIssue, ... each addressed by `cloudId`). It is the same server as
// mockJiraMcpServer.mjs with the surface switched, so both adapters share one set of fixtures.

process.env.MOCK_JIRA_SURFACE = 'atlassian';
await import('./mockJiraMcpServer.mjs');
