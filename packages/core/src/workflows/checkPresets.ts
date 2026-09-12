import type {
  CheckResultAdapterKind,
  WorkflowCheckNode,
  WorkflowGateKind
} from './workflowTypes';

export interface CheckPreset {
  id: string;
  name: string;
  description: string;
  category: 'security' | 'qa' | 'license';
  command: string;
  args?: string[];
  adapter: CheckResultAdapterKind;
  reportPath: string;
  satisfiesGate?: WorkflowGateKind;
  applicableStacks?: string[];
  rulesetPath?: string;
}

export const SECRET_SCAN_PRESET: CheckPreset = {
  id: 'secret-scan',
  name: 'Secret Scanning (Gitleaks)',
  description: 'Detect hardcoded secrets, keys, and credentials using Gitleaks',
  category: 'security',
  command: 'gitleaks',
  args: ['detect', '--no-git', '--report-format', 'sarif', '--report-path', 'gitleaks.sarif'],
  adapter: 'sarif',
  reportPath: 'gitleaks.sarif',
  satisfiesGate: 'security',
  applicableStacks: ['*']
};

export const SAST_SEMGREP_PRESET: CheckPreset = {
  id: 'sast-semgrep',
  name: 'SAST (Semgrep)',
  description: 'Static application security testing with curated ruleset',
  category: 'security',
  command: 'semgrep',
  args: ['scan', '--config', 'rulesets/semgrep-curated.yaml', '--sarif', '--output', 'semgrep.sarif'],
  rulesetPath: 'rulesets/semgrep-curated.yaml',
  adapter: 'sarif',
  reportPath: 'semgrep.sarif',
  satisfiesGate: 'security',
  applicableStacks: ['javascript', 'typescript', 'python', 'go', 'java', 'csharp', 'ruby', 'rust']
};

export const SCA_OSV_PRESET: CheckPreset = {
  id: 'sca-osv',
  name: 'SCA (OSV-Scanner)',
  description: 'Software composition analysis for vulnerable open-source dependencies',
  category: 'security',
  command: 'osv-scanner',
  args: ['scan', '--format', 'sarif', '--output', 'osv-report.sarif', '.'],
  adapter: 'sarif',
  reportPath: 'osv-report.sarif',
  satisfiesGate: 'security',
  applicableStacks: ['javascript', 'typescript', 'python', 'go', 'rust', 'java']
};

export const SCA_TRIVY_PRESET: CheckPreset = {
  id: 'sca-trivy',
  name: 'SCA (Trivy Filesystem)',
  description: 'Filesystem and package vulnerability scanner for container and .NET stacks',
  category: 'security',
  command: 'trivy',
  args: ['fs', '--format', 'sarif', '--output', 'trivy-report.sarif', '.'],
  adapter: 'sarif',
  reportPath: 'trivy-report.sarif',
  satisfiesGate: 'security',
  applicableStacks: ['dotnet', 'csharp', 'container']
};

export const LICENSE_CHECK_PRESET: CheckPreset = {
  id: 'license-check',
  name: 'License Policy Check',
  description: 'Audit open-source dependencies against approved software licenses',
  category: 'license',
  command: 'license-checker',
  args: ['--sarif', '--output', 'license-report.sarif'],
  adapter: 'sarif',
  reportPath: 'license-report.sarif',
  satisfiesGate: 'security',
  applicableStacks: ['javascript', 'typescript']
};

export const CHECK_PRESETS: readonly CheckPreset[] = [
  SECRET_SCAN_PRESET,
  SAST_SEMGREP_PRESET,
  SCA_OSV_PRESET,
  SCA_TRIVY_PRESET,
  LICENSE_CHECK_PRESET
];

export interface StackInspectionInput {
  languages?: string[];
  manifests?: string[];
  frameworks?: string[];
}

/**
 * Automatically picks recommended check presets based on folder inspection findings.
 * Defaults to secrets + semgrep + osv-scanner for standard stacks (e.g. Node),
 * and includes the .NET SCA target when .NET is detected.
 */
export function detectRecommendedCheckPresets(
  inspection?: StackInspectionInput
): CheckPreset[] {
  const presets: CheckPreset[] = [SECRET_SCAN_PRESET];
  if (!inspection) {
    return presets;
  }

  const langs = (inspection.languages ?? []).map(l => l.toLowerCase());
  const manifests = (inspection.manifests ?? []).map(m => m.toLowerCase());
  const frameworks = (inspection.frameworks ?? []).map(f => f.toLowerCase());

  const hasCode = langs.length > 0 || manifests.length > 0;
  if (hasCode) {
    presets.push(SAST_SEMGREP_PRESET);
  }

  const isDotNet =
    langs.includes('c#') ||
    langs.includes('csharp') ||
    frameworks.includes('.net') ||
    frameworks.includes('dotnet') ||
    manifests.some(m => m.endsWith('.csproj') || m.endsWith('.sln'));

  if (isDotNet) {
    presets.push(SCA_TRIVY_PRESET);
  } else if (hasCode) {
    presets.push(SCA_OSV_PRESET);
  }

  return presets;
}

export function createCheckNodeFromPreset(
  preset: CheckPreset,
  options?: {
    id?: string;
    x?: number;
    y?: number;
    inputs?: string[];
    satisfiesGate?: WorkflowGateKind;
  }
): WorkflowCheckNode {
  const nodeId = options?.id ?? preset.id;
  return {
    id: nodeId,
    name: preset.name,
    type: 'check',
    command: preset.command,
    args: preset.args ? [...preset.args] : undefined,
    adapter: preset.adapter,
    reportPath: preset.reportPath,
    satisfiesGate: options?.satisfiesGate ?? preset.satisfiesGate,
    x: options?.x ?? 0,
    y: options?.y ?? 0,
    inputs: options?.inputs ? [...options.inputs] : [],
    outputs: [
      {
        id: `${nodeId}-findings`,
        kind: 'findings',
        required: true,
        adapter: preset.adapter,
        description: `Normalized findings from ${preset.name}`
      }
    ]
  };
}
