import type { CapabilityResolution, JiraCapabilities, ToolDescriptor } from '../types';

const REQUIRED_TOOL_ALIASES: Record<
  'getProjects' | 'searchIssues' | 'getIssue' | 'getTransitions' | 'transitionIssue',
  string[]
> = {
  getProjects: ['atlassian-jira_get_all_projects', 'jira_get_all_projects'],
  searchIssues: ['atlassian-jira_search', 'jira_search'],
  getIssue: ['atlassian-jira_get_issue', 'jira_get_issue'],
  getTransitions: ['atlassian-jira_get_transitions', 'jira_get_transitions'],
  transitionIssue: ['atlassian-jira_transition_issue', 'jira_transition_issue']
};

const OPTIONAL_TOOL_ALIASES: Partial<Record<keyof JiraCapabilities, string[]>> = {
  getAgileBoards: ['atlassian-jira_get_agile_boards', 'jira_get_agile_boards'],
  getBoardIssues: ['atlassian-jira_get_board_issues', 'jira_get_board_issues']
};

export function resolveJiraCapabilities(tools: ToolDescriptor[]): CapabilityResolution {
  const toolNames = new Set(tools.map(tool => tool.name));
  const capabilities = {} as JiraCapabilities;
  const missing: Array<keyof JiraCapabilities> = [];

  for (const key of Object.keys(REQUIRED_TOOL_ALIASES) as Array<keyof typeof REQUIRED_TOOL_ALIASES>) {
    const matchedName = REQUIRED_TOOL_ALIASES[key].find(candidate => toolNames.has(candidate));
    if (matchedName) {
      capabilities[key] = matchedName;
    } else {
      missing.push(key);
    }
  }

  for (const key of Object.keys(OPTIONAL_TOOL_ALIASES) as Array<keyof typeof OPTIONAL_TOOL_ALIASES>) {
    const aliases = OPTIONAL_TOOL_ALIASES[key];
    if (!aliases) {
      continue;
    }

    const matchedName = aliases.find(candidate => toolNames.has(candidate));
    if (matchedName) {
      capabilities[key] = matchedName;
    }
  }

  return {
    capabilities: missing.length === 0 ? capabilities : undefined,
    missing
  };
}
