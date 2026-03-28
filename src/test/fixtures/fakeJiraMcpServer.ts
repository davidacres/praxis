import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

type Scenario = 'default' | 'no-projects' | 'missing-capabilities' | 'parent-unsupported';

interface FakeTransition {
  id: string;
  name: string;
  toStatus: string;
}

interface FakeIssue {
  id: string;
  key: string;
  summary: string;
  status: string;
  issueType: string;
  projectKey: string;
  projectName: string;
  assigneeMode: 'me' | 'other' | 'none';
  assigneeDisplayName?: string;
  priority: string;
  updated: string;
  description: string;
  parent?: string;
  transitions: FakeTransition[];
  failTransition?: boolean;
}

interface FakeBoard {
  id: string;
  name: string;
  type: 'scrum' | 'kanban';
  projectKey: string;
  projectName: string;
  issueKeys: string[];
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value)
      }
    ]
  };
}

function statusCategoryName(status: string): string {
  switch (status) {
    case 'Done':
      return 'done';
    case 'In Progress':
    case 'Blocked':
      return 'indeterminate';
    default:
      return 'todo';
  }
}

function transitionSet(status: string): FakeTransition[] {
  switch (status) {
    case 'To Do':
      return [
        { id: 'start-progress', name: 'Start Progress', toStatus: 'In Progress' },
        { id: 'mark-done', name: 'Done', toStatus: 'Done' }
      ];
    case 'In Progress':
      return [
        { id: 'mark-done', name: 'Done', toStatus: 'Done' },
        { id: 'block', name: 'Block', toStatus: 'Blocked' }
      ];
    case 'Blocked':
      return [{ id: 'resume', name: 'Resume', toStatus: 'In Progress' }];
    default:
      return [];
  }
}

function createIssues(): FakeIssue[] {
  return [
    {
      id: '1',
      key: 'APP-100',
      summary: 'Core app epic',
      status: 'In Progress',
      issueType: 'Epic',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeMode: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'High',
      updated: '2026-03-27T20:00:00.000Z',
      description: 'Primary epic for the application platform work.',
      transitions: transitionSet('In Progress')
    },
    {
      id: '2',
      key: 'APP-101',
      summary: 'Implement MCP adapter',
      status: 'To Do',
      issueType: 'Story',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeMode: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'High',
      updated: '2026-03-27T20:10:00.000Z',
      description: 'Build the reusable MCP client adapter.',
      parent: 'APP-100',
      transitions: transitionSet('To Do')
    },
    {
      id: '3',
      key: 'APP-102',
      summary: 'Build issue tree view',
      status: 'In Progress',
      issueType: 'Task',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeMode: 'other',
      assigneeDisplayName: 'Jordan Builder',
      priority: 'Medium',
      updated: '2026-03-27T20:20:00.000Z',
      description: 'Render grouped issues in the sidebar.',
      parent: 'APP-100',
      transitions: transitionSet('In Progress')
    },
    {
      id: '4',
      key: 'APP-103',
      summary: 'Transition validation edge case',
      status: 'Blocked',
      issueType: 'Task',
      projectKey: 'APP',
      projectName: 'Application Platform',
      assigneeMode: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'Low',
      updated: '2026-03-27T20:30:00.000Z',
      description: 'This issue simulates a workflow that requires extra fields.',
      parent: 'APP-100',
      transitions: transitionSet('Blocked'),
      failTransition: true
    },
    {
      id: '5',
      key: 'OPS-200',
      summary: 'Triage production incident',
      status: 'To Do',
      issueType: 'Bug',
      projectKey: 'OPS',
      projectName: 'Operations',
      assigneeMode: 'me',
      assigneeDisplayName: 'Alex Agent',
      priority: 'Critical',
      updated: '2026-03-27T21:00:00.000Z',
      description: 'Investigate the latest customer-facing incident.',
      transitions: transitionSet('To Do')
    }
  ];
}

function createBoards(): FakeBoard[] {
  return [
    {
      id: '1',
      name: 'Application Board',
      type: 'scrum',
      projectKey: 'APP',
      projectName: 'Application Platform',
      issueKeys: ['APP-101', 'APP-102', 'APP-103']
    },
    {
      id: '2',
      name: 'Platform Overview',
      type: 'scrum',
      projectKey: 'APP',
      projectName: 'Application Platform',
      issueKeys: ['APP-100']
    },
    {
      id: '3',
      name: 'Operations Board',
      type: 'kanban',
      projectKey: 'OPS',
      projectName: 'Operations',
      issueKeys: ['OPS-200']
    }
  ];
}

function issueToJiraShape(issue: FakeIssue) {
  return {
    id: issue.id,
    key: issue.key,
    self: `https://example.atlassian.net/rest/api/3/issue/${issue.key}`,
    fields: {
      summary: issue.summary,
      status: {
        name: issue.status,
        statusCategory: {
          name: statusCategoryName(issue.status)
        }
      },
      issuetype: {
        name: issue.issueType
      },
      assignee:
        issue.assigneeMode === 'none'
          ? null
          : {
              displayName: issue.assigneeDisplayName
            },
      priority: {
        name: issue.priority
      },
      updated: issue.updated,
      project: {
        key: issue.projectKey,
        name: issue.projectName
      },
      parent: issue.parent
        ? {
            key: issue.parent
          }
        : undefined,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: issue.description
              }
            ]
          }
        ]
      }
    }
  };
}

function boardToJiraShape(board: FakeBoard) {
  return {
    id: board.id,
    name: board.name,
    type: board.type,
    location: {
      name: board.projectName,
      projectKey: board.projectKey,
      projectName: board.projectName
    }
  };
}

function parseScenario(): Scenario {
  const scenarioArg = process.argv.find(arg => arg.startsWith('--scenario='));
  const scenario = scenarioArg?.split('=')[1] as Scenario | undefined;
  return scenario ?? 'default';
}

function parseQuotedValues(text: string): string[] {
  return [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

function extractSingleValue(jql: string, field: string): string | undefined {
  const match = new RegExp(`${field}\\s*=\\s*"([^"]+)"`, 'i').exec(jql);
  return match?.[1];
}

function extractListValues(jql: string, field: string): string[] {
  const listMatch = new RegExp(`${field}\\s+in\\s*\\(([^)]+)\\)`, 'i').exec(jql);
  if (listMatch?.[1]) {
    return parseQuotedValues(listMatch[1]);
  }

  const singleValue = extractSingleValue(jql, field);
  return singleValue ? [singleValue] : [];
}

function extractTextQuery(jql: string): string | undefined {
  const match = /text\s*~\s*"([^"]+)"/i.exec(jql);
  return match?.[1];
}

function matchesQuery(issue: FakeIssue, jql: string, scenario: Scenario): boolean {
  const normalizedJql = jql.replace(/\s+/g, ' ');
  if (scenario === 'parent-unsupported' && /\bparent\s*=/.test(normalizedJql)) {
    throw new Error('The parent field is not available in this Jira instance.');
  }

  const projectValues = extractListValues(normalizedJql, 'project');
  if (projectValues.length > 0 && !projectValues.includes(issue.projectKey)) {
    return false;
  }

  if (/assignee\s*=\s*currentUser\(\)/i.test(normalizedJql) && issue.assigneeMode !== 'me') {
    return false;
  }

  const statusValues = extractListValues(normalizedJql, 'status');
  if (statusValues.length > 0 && !statusValues.includes(issue.status)) {
    return false;
  }

  const issueTypeValues = extractListValues(normalizedJql, 'issuetype');
  if (issueTypeValues.length > 0 && !issueTypeValues.includes(issue.issueType)) {
    return false;
  }

  const textQuery = extractTextQuery(normalizedJql);
  if (textQuery) {
    const searchHaystack = `${issue.key} ${issue.summary} ${issue.description}`.toLowerCase();
    if (!searchHaystack.includes(textQuery.toLowerCase())) {
      return false;
    }
  }

  const parentValue = extractSingleValue(normalizedJql, 'parent');
  if (parentValue && issue.parent !== parentValue) {
    return false;
  }

  const parentEpicValue = extractSingleValue(normalizedJql, 'parentEpic');
  if (parentEpicValue && issue.parent !== parentEpicValue) {
    return false;
  }

  return true;
}

async function main(): Promise<void> {
  const scenario = parseScenario();
  const server = new McpServer({
    name: 'fake-jira-mcp',
    version: '1.0.0'
  });
  const issues = createIssues();
  const boards = createBoards();

  function getProjectName(projectKey: string): string {
    return boards.find(board => board.projectKey === projectKey)?.projectName ?? projectKey;
  }

  function getNextIssueKey(projectKey: string): string {
    const nextNumber =
      issues
        .map(issue => {
          const match = issue.key.match(new RegExp(`^${projectKey}-(\\d+)$`));
          const numericPart = match?.[1];
          return numericPart ? Number.parseInt(numericPart, 10) : undefined;
        })
        .reduce<number>(
          (max, value) => (typeof value === 'number' && value > max ? value : max),
          0
        ) + 1;

    return `${projectKey}-${nextNumber}`;
  }

  function attachIssueToBoard(issueKey: string, projectKey: string): void {
    const targetBoard =
      boards.find(board => board.projectKey === projectKey && !board.name.toLowerCase().includes('overview')) ??
      boards.find(board => board.projectKey === projectKey);
    if (targetBoard) {
      targetBoard.issueKeys.push(issueKey);
    }
  }

  function detachIssueFromBoards(issueKey: string): void {
    for (const board of boards) {
      board.issueKeys = board.issueKeys.filter(key => key !== issueKey);
    }
  }

  function clearParentReferences(parentKey: string): void {
    for (const issue of issues) {
      if (issue.parent === parentKey) {
        issue.parent = undefined;
        issue.updated = new Date().toISOString();
      }
    }
  }

  server.registerTool(
    'atlassian-jira_get_all_projects',
    {
      description: 'Return the fake Jira project list.',
      inputSchema: {
        include_archived: z.boolean().optional()
      }
    },
    async () => {
      if (scenario === 'no-projects') {
        return jsonResult([]);
      }

      return jsonResult([
        {
          id: '100',
          key: 'APP',
          name: 'Application Platform'
        },
        {
          id: '200',
          key: 'OPS',
          name: 'Operations'
        }
      ]);
    }
  );

  server.registerTool(
    'atlassian-jira_search',
    {
      description: 'Search fake Jira issues using a limited JQL subset.',
      inputSchema: {
        jql: z.string(),
        fields: z.string().optional(),
        limit: z.number().optional(),
        start_at: z.number().optional()
      }
    },
    async ({ jql, limit = 25, start_at = 0 }) => {
      if (scenario === 'no-projects') {
        return jsonResult({
          issues: [],
          total: 0,
          isLast: true
        });
      }

      const matchingIssues = issues
        .filter(issue => matchesQuery(issue, jql, scenario))
        .sort((a, b) => b.updated.localeCompare(a.updated));
      const pagedIssues = matchingIssues.slice(start_at, start_at + limit).map(issueToJiraShape);

      return jsonResult({
        issues: pagedIssues,
        total: matchingIssues.length,
        isLast: start_at + limit >= matchingIssues.length
      });
    }
  );

  server.registerTool(
    'atlassian-jira_create_issue',
    {
      description: 'Create a fake Jira issue.',
      inputSchema: {
        project_key: z.string(),
        summary: z.string(),
        issue_type: z.string(),
        description: z.string().optional(),
        additional_fields: z.string().optional()
      }
    },
    async ({ project_key, summary, issue_type, description, additional_fields }) => {
      if (scenario === 'no-projects') {
        throw new Error(`Project ${project_key} was not found.`);
      }

      let parent: string | undefined;
      if (additional_fields) {
        try {
          const parsed = JSON.parse(additional_fields) as Record<string, unknown>;
          if (typeof parsed.epicKey === 'string') {
            parent = parsed.epicKey;
          } else if (typeof parsed.parent === 'string') {
            parent = parsed.parent;
          }
        } catch {
          parent = undefined;
        }
      }

      const createdIssue: FakeIssue = {
        id: String(issues.length + 1),
        key: getNextIssueKey(project_key),
        summary,
        status: 'To Do',
        issueType: issue_type,
        projectKey: project_key,
        projectName: getProjectName(project_key),
        assigneeMode: 'me',
        assigneeDisplayName: 'Alex Agent',
        priority: 'Medium',
        updated: new Date().toISOString(),
        description: description ?? '',
        parent,
        transitions: transitionSet('To Do')
      };

      issues.unshift(createdIssue);
      attachIssueToBoard(createdIssue.key, createdIssue.projectKey);

      return jsonResult(issueToJiraShape(createdIssue));
    }
  );

  server.registerTool(
    'atlassian-jira_update_issue',
    {
      description: 'Update a fake Jira issue.',
      inputSchema: {
        issue_key: z.string(),
        fields: z.string(),
        additional_fields: z.string().optional()
      }
    },
    async ({ issue_key, fields, additional_fields }) => {
      const issue = issues.find(candidate => candidate.key === issue_key);
      if (!issue) {
        throw new Error(`Issue ${issue_key} was not found.`);
      }

      let parsedFields: Record<string, unknown> = {};
      try {
        parsedFields = fields ? (JSON.parse(fields) as Record<string, unknown>) : {};
      } catch {
        parsedFields = {};
      }

      if (typeof parsedFields.summary === 'string') {
        issue.summary = parsedFields.summary;
      }
      if (typeof parsedFields.description === 'string') {
        issue.description = parsedFields.description;
      }

      if (additional_fields) {
        try {
          const parsed = JSON.parse(additional_fields) as Record<string, unknown>;
          if (typeof parsed.epicKey === 'string') {
            issue.parent = parsed.epicKey;
          } else if (parsed.epicKey === null) {
            issue.parent = undefined;
          }
        } catch {
          // Ignore malformed additional fields in the fake server.
        }
      }

      issue.updated = new Date().toISOString();
      return jsonResult(issueToJiraShape(issue));
    }
  );

  server.registerTool(
    'atlassian-jira_delete_issue',
    {
      description: 'Delete a fake Jira issue.',
      inputSchema: {
        issue_key: z.string()
      }
    },
    async ({ issue_key }) => {
      const issueIndex = issues.findIndex(candidate => candidate.key === issue_key);
      if (issueIndex < 0) {
        throw new Error(`Issue ${issue_key} was not found.`);
      }

      issues.splice(issueIndex, 1);
      detachIssueFromBoards(issue_key);
      clearParentReferences(issue_key);

      return jsonResult({
        ok: true,
        issueKey: issue_key
      });
    }
  );

  server.registerTool(
    'atlassian-jira_get_agile_boards',
    {
      description: 'List fake Jira agile boards.',
      inputSchema: {
        board_name: z.string().optional(),
        project_key: z.string().optional(),
        board_type: z.string().optional(),
        start_at: z.number().optional(),
        limit: z.number().optional()
      }
    },
    async ({ board_name, project_key, board_type, start_at = 0, limit = 50 }) => {
      if (scenario === 'no-projects') {
        return jsonResult({
          values: [],
          total: 0,
          isLast: true
        });
      }

      const matchingBoards = boards.filter(board => {
        if (project_key && board.projectKey !== project_key) {
          return false;
        }

        if (board_type && board.type !== board_type) {
          return false;
        }

        if (board_name && !board.name.toLowerCase().includes(board_name.toLowerCase())) {
          return false;
        }

        return true;
      });

      const pagedBoards = matchingBoards.slice(start_at, start_at + limit).map(boardToJiraShape);
      return jsonResult({
        values: pagedBoards,
        total: matchingBoards.length,
        isLast: start_at + limit >= matchingBoards.length
      });
    }
  );

  server.registerTool(
    'atlassian-jira_get_board_issues',
    {
      description: 'Get fake Jira issues for a board.',
      inputSchema: {
        board_id: z.string(),
        jql: z.string(),
        fields: z.string().optional(),
        start_at: z.number().optional(),
        limit: z.number().optional()
      }
    },
    async ({ board_id, jql, start_at = 0, limit = 50 }) => {
      const board = boards.find(candidate => candidate.id === board_id);
      if (!board) {
        throw new Error(`Board ${board_id} was not found.`);
      }

      const matchingIssues = issues
        .filter(issue => board.issueKeys.includes(issue.key))
        .filter(issue => matchesQuery(issue, jql, scenario))
        .sort((a, b) => b.updated.localeCompare(a.updated));
      const pagedIssues = matchingIssues.slice(start_at, start_at + limit).map(issueToJiraShape);

      return jsonResult({
        issues: pagedIssues,
        total: matchingIssues.length,
        isLast: start_at + limit >= matchingIssues.length
      });
    }
  );

  server.registerTool(
    'atlassian-jira_get_issue',
    {
      description: 'Get a fake Jira issue by key.',
      inputSchema: {
        issue_key: z.string(),
        fields: z.string().optional()
      }
    },
    async ({ issue_key }) => {
      const issue = issues.find(candidate => candidate.key === issue_key);
      if (!issue) {
        throw new Error(`Issue ${issue_key} was not found.`);
      }

      return jsonResult(issueToJiraShape(issue));
    }
  );

  server.registerTool(
    'atlassian-jira_get_transitions',
    {
      description: 'Get available transitions for a fake Jira issue.',
      inputSchema: {
        issue_key: z.string()
      }
    },
    async ({ issue_key }) => {
      const issue = issues.find(candidate => candidate.key === issue_key);
      if (!issue) {
        throw new Error(`Issue ${issue_key} was not found.`);
      }

      return jsonResult({
        transitions: issue.transitions.map(transition => ({
          id: transition.id,
          name: transition.name,
          to: {
            name: transition.toStatus
          }
        }))
      });
    }
  );

  if (scenario !== 'missing-capabilities') {
    server.registerTool(
      'atlassian-jira_transition_issue',
      {
        description: 'Transition a fake Jira issue to a new status.',
        inputSchema: {
          issue_key: z.string(),
          transition_id: z.string()
        }
      },
      async ({ issue_key, transition_id }) => {
        const issue = issues.find(candidate => candidate.key === issue_key);
        if (!issue) {
          throw new Error(`Issue ${issue_key} was not found.`);
        }

        const transition = issue.transitions.find(candidate => candidate.id === transition_id);
        if (!transition) {
          throw new Error(`Transition ${transition_id} is not valid for ${issue_key}.`);
        }

        if (issue.failTransition) {
          throw new Error(
            `Workflow rejected the transition for ${issue_key} because extra fields are required.`
          );
        }

        issue.status = transition.toStatus;
        issue.updated = new Date().toISOString();
        issue.transitions = transitionSet(issue.status);

        return jsonResult({
          ok: true,
          issueKey: issue.key,
          status: issue.status
        });
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
