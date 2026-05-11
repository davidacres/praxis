import type {
  CapabilityResolution,
  JiraCapabilities,
  JiraCapabilityName,
  JiraMcpContract,
  ToolDescriptor
} from '../types';

type ToolMatcher = Partial<Record<JiraCapabilityName, string[]>>;

interface NormalizedTool {
  name: string;
  canonical: string;
}

const LEGACY_REQUIRED_MATCHERS: Record<
  'getProjects' | 'searchIssues' | 'getIssue' | 'getTransitions' | 'transitionIssue',
  string[]
> = {
  getProjects: ['atlassianjiragetallprojects', 'jiragetallprojects'],
  searchIssues: ['atlassianjirasearch', 'jirasearch'],
  getIssue: ['atlassianjiragetissue', 'jiragetissue'],
  getTransitions: ['atlassianjiragettransitions', 'jiragettransitions'],
  transitionIssue: ['atlassianjiratransitionissue', 'jiratransitionissue']
};

const LEGACY_OPTIONAL_MATCHERS: ToolMatcher = {
  createIssue: ['atlassianjiracreateissue', 'jiracreateissue'],
  updateIssue: ['atlassianjiraupdateissue', 'jiraupdateissue'],
  deleteIssue: ['atlassianjiradeleteissue', 'jiradeleteissue'],
  addComment: ['atlassianjiraaddcomment', 'jiraaddcomment'],
  getAgileBoards: ['atlassianjiragetagileboards', 'jiragetagileboards'],
  getBoardIssues: ['atlassianjiragetboardissues', 'jiragetboardissues']
};

const ATLASSIAN_REQUIRED_MATCHERS: Record<
  'getProjects' | 'searchIssues' | 'getIssue' | 'getTransitions',
  string[]
> = {
  getProjects: ['getvisiblejiraprojects'],
  searchIssues: ['searchjiraissuesusingjql'],
  getIssue: ['getjiraissue'],
  getTransitions: ['gettransitionsforjiraissue']
};

const ATLASSIAN_OPTIONAL_MATCHERS: ToolMatcher = {
  createIssue: ['createjiraissue'],
  updateIssue: ['updatejiraissue'],
  deleteIssue: ['deletejiraissue'],
  addComment: ['addcommenttojiraissue', 'addjiraissuecomment'],
  accessibleResources: ['getaccessibleatlassianresources']
};

function canonicalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normalizeTools(tools: ToolDescriptor[]): NormalizedTool[] {
  return tools.map(tool => ({
    name: tool.name,
    canonical: canonicalizeToolName(tool.name)
  }));
}

function findMatchingTool(tools: NormalizedTool[], patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    const exactMatch = tools.find(tool => tool.canonical === pattern);
    if (exactMatch) {
      return exactMatch.name;
    }
  }

  for (const pattern of patterns) {
    const partialMatch = tools.find(tool => tool.canonical.includes(pattern));
    if (partialMatch) {
      return partialMatch.name;
    }
  }

  return undefined;
}

function detectContract(tools: NormalizedTool[]): JiraMcpContract {
  const hasAtlassianCore =
    Boolean(findMatchingTool(tools, ATLASSIAN_REQUIRED_MATCHERS.getProjects)) ||
    Boolean(findMatchingTool(tools, ATLASSIAN_REQUIRED_MATCHERS.searchIssues)) ||
    Boolean(findMatchingTool(tools, ATLASSIAN_OPTIONAL_MATCHERS.accessibleResources ?? []));
  if (hasAtlassianCore) {
    return 'atlassian-cloud';
  }

  const hasLegacyCore =
    Boolean(findMatchingTool(tools, LEGACY_REQUIRED_MATCHERS.getProjects)) &&
    Boolean(findMatchingTool(tools, LEGACY_REQUIRED_MATCHERS.searchIssues)) &&
    Boolean(findMatchingTool(tools, LEGACY_REQUIRED_MATCHERS.getIssue));

  return hasLegacyCore ? 'legacy' : 'atlassian-cloud';
}

function resolveOptionalCapabilities(
  capabilities: JiraCapabilities,
  tools: NormalizedTool[],
  matchers: ToolMatcher
): void {
  for (const key of Object.keys(matchers) as JiraCapabilityName[]) {
    const patterns = matchers[key];
    if (!patterns) {
      continue;
    }

    const matchedName = findMatchingTool(tools, patterns);
    if (matchedName) {
      capabilities[key] = matchedName;
    }
  }
}

export function resolveJiraCapabilities(tools: ToolDescriptor[]): CapabilityResolution {
  const normalizedTools = normalizeTools(tools);
  const contract = detectContract(normalizedTools);
  const capabilities = { contract } as JiraCapabilities;
  const missing: JiraCapabilityName[] = [];

  if (contract === 'legacy') {
    for (const key of Object.keys(LEGACY_REQUIRED_MATCHERS) as Array<keyof typeof LEGACY_REQUIRED_MATCHERS>) {
      const matchedName = findMatchingTool(normalizedTools, LEGACY_REQUIRED_MATCHERS[key]);
      if (matchedName) {
        capabilities[key] = matchedName;
      } else {
        missing.push(key);
      }
    }

    resolveOptionalCapabilities(capabilities, normalizedTools, LEGACY_OPTIONAL_MATCHERS);
  } else {
    for (const key of Object.keys(ATLASSIAN_REQUIRED_MATCHERS) as Array<keyof typeof ATLASSIAN_REQUIRED_MATCHERS>) {
      const matchedName = findMatchingTool(normalizedTools, ATLASSIAN_REQUIRED_MATCHERS[key]);
      if (matchedName) {
        capabilities[key] = matchedName;
      } else {
        missing.push(key);
      }
    }

    resolveOptionalCapabilities(capabilities, normalizedTools, ATLASSIAN_OPTIONAL_MATCHERS);
  }

  return {
    capabilities: missing.length === 0 ? capabilities : undefined,
    missing
  };
}
